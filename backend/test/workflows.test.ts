import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { SignJWT } from 'jose';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config.js';
import { hashPassword } from '../src/password.js';
import { LocalStorage, type PrivateStorage } from '../src/storage.js';
import type { Database } from '../src/db.js';
import { testDatabase } from './helpers.js';

let app: FastifyInstance; let db: Database; let close: () => Promise<void>; let directory: string;
let admin: Account; let officer: Account; let other: Account; let passwordHash: string;
let storageFail = false;
const password = 'test-only-secure-password';
const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', JWT_SECRET: 'phase-two-tests-only-secret-'.repeat(3) });
type Account = { userId: string; fmoId: string; employeeCode: string; token: string; refresh: string };
let ipCounter = 10;
async function request(method: InjectOptions['method'], url: string, token?: string, payload?: unknown, extra: Partial<InjectOptions> = {}) {
  return app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as InjectOptions['payload'] } : {}), remoteAddress: `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250 + 1}`, ...extra });
}
async function account(role: 'SUPER_ADMIN' | 'ADMIN' | 'FMO' = 'FMO'): Promise<Account> {
  const userId = randomUUID(); const fmoId = randomUUID(); const employeeCode = `T-${randomUUID().toUpperCase()}`;
  await db.query('INSERT INTO users(id,login_id,name,role,password_hash) VALUES ($1,$2,$3,$4,$5)', [userId, employeeCode, 'Test Officer', role, passwordHash]);
  if (role === 'FMO') await db.query('INSERT INTO fmos(id,user_id) VALUES ($1,$2)', [fmoId, userId]);
  const response = await request('POST', '/api/auth/login', undefined, { employeeCode, password });
  assert.equal(response.statusCode, 200, response.body);
  return { userId, fmoId, employeeCode, token: response.json().accessToken, refresh: response.json().refreshToken };
}
function point(overrides: Record<string, unknown> = {}) {
  return { clientPointId: randomUUID(), latitude: 32.932, longitude: 72.855, accuracy: 8, recordedAt: new Date().toISOString(), ...overrides };
}
async function start(a: Account) {
  const input = { requestId: randomUUID(), location: point(), device: { installationId: randomUUID(), model: 'Test Android' } };
  const result = await request('POST', '/api/duty/start', a.token, input);
  assert.equal(result.statusCode, 201, result.body);
  return { id: result.json().session.id as string, input, response: result.json() };
}
let imageCounter = 20;
async function checkInPayload(a: Account, session: string) {
  const challenge = await request('POST', '/api/duty/check-in/challenge', a.token, { dutySessionId: session });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const metadata = { requestId: randomUUID(), dutySessionId: session, challengeToken: challenge.json().challengeToken, location: point() };
  const image = await sharp({ create: { width: 240, height: 240, channels: 3, background: { r: imageCounter++, g: 100, b: 120 } } }).jpeg().toBuffer();
  return { metadata, image };
}
async function submitCheckIn(a: Account, metadata: unknown, image: Buffer, mime = 'image/jpeg') {
  const boundary = `fmo-test-${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="selfie"; filename="camera.jpg"\r\nContent-Type: ${mime}\r\n\r\n`),
    image, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return request('POST', '/api/duty/check-in', a.token, undefined, { payload, headers: { authorization: `Bearer ${a.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
}
before(async () => {
  ({ db, close } = await testDatabase());
  directory = await mkdtemp(join(tmpdir(), 'fmo-api-test-'));
  const local = new LocalStorage(directory);
  const storage: PrivateStorage = { get: key => local.get(key), put: async (key, bytes, mime) => { if (storageFail) throw new Error('Storage test failure'); return local.put(key, bytes); } };
  app = await buildApp(env, async () => true, { db, storage });
  passwordHash = await hashPassword(password);
  admin = await account('SUPER_ADMIN'); officer = await account(); other = await account();
});
after(async () => {
  if (app) await app.close(); if (close) await close();
  if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep + 'fmo-api-test-')) await rm(directory, { recursive: true, force: true });
});

test('login, identity, invalid credentials, expired/forged tokens and role restrictions', async () => {
  const invalid = await request('POST', '/api/auth/login', undefined, { employeeCode: officer.employeeCode, password: 'wrong' });
  assert.equal(invalid.statusCode, 401);
  assert.equal((await request('POST', '/api/auth/login', undefined, { employeeCode: 'UNKNOWN-FMO', password: 'wrong' })).statusCode, 401);
  const me = await request('GET', '/api/auth/me', officer.token);
  assert.equal(me.json().user.fmoId, officer.fmoId); assert.equal(me.body.includes('password'), false);
  assert.equal((await request('GET', '/api/fmos')).statusCode, 401);
  assert.equal((await request('GET', '/api/fmos', officer.token)).statusCode, 403);
  assert.equal((await request('GET', '/api/duty/current', admin.token)).statusCode, 403);
  assert.equal((await request('GET', '/api/auth/me', officer.token + 'bad')).statusCode, 401);
  const expired = await new SignJWT({ sid: randomUUID(), ver: 1 }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(officer.userId)
    .setIssuer('fmo-api').setAudience('fmo-clients').setExpirationTime(1).sign(new TextEncoder().encode(env.JWT_SECRET));
  assert.equal((await request('GET', '/api/auth/me', expired)).statusCode, 401);
  const incompleteCode = `INCOMPLETE-${randomUUID().toUpperCase()}`;
  await db.query("INSERT INTO users(login_id,name,role,password_hash) VALUES ($1,'Incomplete','FMO',$2)", [incompleteCode, passwordHash]);
  assert.equal((await request('POST', '/api/auth/login', undefined, { employeeCode: incompleteCode, password })).statusCode, 401);
});
test('web sessions use HttpOnly cookies, enforce Origin, and rotate without exposing refresh token', async () => {
  const user = await account('ADMIN');
  const payload = { employeeCode: user.employeeCode, password, client: 'web' };
  assert.equal((await request('POST', '/api/auth/login', undefined, payload)).statusCode, 403);
  const response = await request('POST', '/api/auth/login', undefined, payload, { headers: { origin: 'http://localhost:3000' } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().refreshToken, undefined);
  const cookie = String(response.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const cookieHeader = cookie.split(';')[0]!;
  assert.equal((await request('POST', '/api/auth/refresh', undefined, {}, { headers: { cookie: cookieHeader, origin: 'https://evil.example' } })).statusCode, 403);
  const refreshed = await request('POST', '/api/auth/refresh', undefined, {}, { headers: { cookie: cookieHeader, origin: 'http://localhost:3000' } });
  assert.equal(refreshed.statusCode, 200); assert.equal(refreshed.json().refreshToken, undefined);
});
test('refresh rotation, replay revocation, concurrent refresh and logout invalidate access', async () => {
  const user = await account();
  const first = await request('POST', '/api/auth/refresh', undefined, { refreshToken: user.refresh });
  assert.equal(first.statusCode, 200);
  assert.notEqual(first.json().refreshToken, user.refresh);
  assert.equal((await request('POST', '/api/auth/refresh', undefined, { refreshToken: user.refresh })).statusCode, 401);
  assert.equal((await request('GET', '/api/auth/me', first.json().accessToken)).statusCode, 401);
  const race = await account();
  const results = await Promise.all([1, 2].map(() => request('POST', '/api/auth/refresh', undefined, { refreshToken: race.refresh })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 401]);
  const success = results.find(r => r.statusCode === 200)!;
  assert.equal((await request('GET', '/api/auth/me', success.json().accessToken)).statusCode, 401);
  const logout = await account();
  assert.equal((await request('POST', '/api/auth/logout', logout.token)).statusCode, 200);
  assert.equal((await request('GET', '/api/auth/me', logout.token)).statusCode, 401);
  assert.equal((await request('POST', '/api/auth/refresh', undefined, { refreshToken: logout.refresh })).statusCode, 401);
});
test('Start Duty is independent, idempotent and protected against simultaneous duplicate starts', async () => {
  const user = await account();
  assert.equal((await request('GET', '/api/duty/current', user.token)).json().session, null);
  const { id, input } = await start(user);
  const current = await request('GET', '/api/duty/current', user.token);
  assert.equal(current.json().attendance, null); assert.equal(current.json().trackingAuthorized, true);
  const session = current.json().session;
  assert.equal(Date.parse(session.expectedEndTime) - Date.parse(session.startTime), 480 * 60000);
  assert.equal((await request('POST', '/api/duty/start', user.token, input)).json().replayed, true);
  assert.equal((await request('POST', '/api/duty/start', user.token, { ...input, location: point() })).statusCode, 409);
  assert.equal((await request('POST', '/api/duty/start', user.token, { ...input, requestId: randomUUID() })).statusCode, 409);
  assert.equal((await request('POST', '/api/duty/end', other.token, { requestId: randomUUID(), dutySessionId: id, finalLocation: point() })).statusCode, 404);
  const raceUser = await account();
  const raceInput = { requestId: randomUUID(), location: point(), device: { installationId: randomUUID() } };
  const results = await Promise.all([1, 2].map(() => request('POST', '/api/duty/start', raceUser.token, raceInput)));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 201]);
  assert.equal(results[0]!.json().session.id, results[1]!.json().session.id);
});
test('check-in and end require duty; mocked, stale and poor initial GPS are rejected', async () => {
  const user = await account();
  assert.equal((await request('POST', '/api/duty/check-in/challenge', user.token, { dutySessionId: randomUUID() })).statusCode, 404);
  assert.equal((await request('POST', '/api/duty/end', user.token, { requestId: randomUUID(), dutySessionId: randomUUID(), finalLocation: point() })).statusCode, 404);
  for (const change of [{ mocked: true }, { accuracy: 150 }, { recordedAt: new Date(Date.now() - 600000).toISOString() }]) {
    const response = await request('POST', '/api/duty/start', user.token, { requestId: randomUUID(), location: point(change), device: { installationId: randomUUID() } });
    assert.equal(response.statusCode, 422, response.body);
  }
  assert.equal((await request('GET', '/api/duty/current', user.token)).json().session, null);
});
test('real multipart check-in stores a private sanitized image and enforces ownership and idempotency', async () => {
  const user = await account(); const { id } = await start(user); const upload = await checkInPayload(user, id);
  const result = await submitCheckIn(user, upload.metadata, upload.image);
  assert.equal(result.statusCode, 201, result.body);
  const attendance = result.json().attendance;
  assert.equal(attendance.verificationStatus, 'NOT_VERIFIED');
  assert.equal(result.body.includes('selfie_storage_key'), false);
  assert.equal((await submitCheckIn(user, upload.metadata, upload.image)).json().replayed, true);
  assert.equal((await submitCheckIn(user, { ...upload.metadata, requestId: randomUUID() }, upload.image)).statusCode, 409);
  const selfie = await request('GET', attendance.selfiePath, admin.token);
  assert.equal(selfie.statusCode, 200, selfie.body); assert.equal(selfie.headers['content-type'], 'image/jpeg');
  assert.match(String(selfie.headers['cache-control']), /no-store/);
  const meta = await sharp(selfie.rawPayload).metadata(); assert.equal(meta.exif, undefined);
  assert.equal((await request('GET', attendance.selfiePath)).statusCode, 401);
  assert.equal((await request('GET', attendance.selfiePath, other.token)).statusCode, 404);
  assert.equal((await request('GET', `/api/attendance/${attendance.id}`, user.token)).statusCode, 200);
  assert.equal((await request('GET', `/api/attendance/${attendance.id}`, other.token)).statusCode, 404);
  assert.equal((await request('GET', `/api/attendance?fmoId=${user.fmoId}`, other.token)).statusCode, 403);
  const own = await request('GET', '/api/attendance', user.token);
  assert.ok(own.json().items.every((a: { fmoId: string }) => a.fmoId === user.fmoId));
});
test('check-in validates content, challenge, GPS and storage failures without confirming attendance', async () => {
  const user = await account(); const { id } = await start(user); const upload = await checkInPayload(user, id);
  assert.equal((await submitCheckIn(user, upload.metadata, Buffer.from('<svg>bad</svg>'), 'image/jpeg')).statusCode, 400);
  assert.equal((await submitCheckIn(user, upload.metadata, upload.image, 'image/png')).statusCode, 400);
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  assert.equal((await submitCheckIn(user, upload.metadata, tiny)).statusCode, 400);
  assert.equal((await submitCheckIn(user, upload.metadata, Buffer.alloc(5 * 1024 * 1024 + 1))).statusCode, 413);
  assert.equal((await submitCheckIn(user, { ...upload.metadata, location: point({ accuracy: 150 }) }, upload.image)).statusCode, 422);
  storageFail = true;
  try { assert.equal((await submitCheckIn(user, upload.metadata, upload.image)).statusCode, 503); }
  finally { storageFail = false; }
  assert.equal((await request('GET', '/api/duty/current', user.token)).json().attendance, null);
  await db.query("UPDATE camera_challenges SET expires_at=now()-interval '1 minute' WHERE duty_session_id=$1", [id]);
  const expired = await submitCheckIn(user, upload.metadata, upload.image);
  assert.equal(expired.statusCode, 422); assert.equal(expired.json().code, 'CHALLENGE_EXPIRED');
});
test('simultaneous check-ins create one attendance and admin reset preserves evidence', async () => {
  const user = await account(); const { id } = await start(user); const upload = await checkInPayload(user, id);
  const race = await Promise.all([1, 2].map(() => submitCheckIn(user, upload.metadata, upload.image)));
  assert.deepEqual(race.map(r => r.statusCode).sort(), [200, 201]);
  const attendanceId = race[0]!.json().attendance.id;
  assert.equal((await request('POST', `/api/attendance/${attendanceId}/reset`, user.token, { reason: 'Wrong capture' })).statusCode, 403);
  assert.equal((await request('POST', `/api/attendance/${attendanceId}/reset`, admin.token, { reason: 'Image requires recapture' })).statusCode, 200);
  assert.equal((await request('GET', '/api/duty/current', user.token)).json().attendance, null);
  assert.equal((await submitCheckIn(user, upload.metadata, upload.image)).json().code, 'CHECK_IN_RESET');
  const next = await checkInPayload(user, id);
  assert.equal((await submitCheckIn(user, next.metadata, upload.image)).json().code, 'SELFIE_REUSED');
  assert.equal((await submitCheckIn(user, next.metadata, next.image)).statusCode, 201);
  assert.equal((await request('GET', `/api/attendance/${attendanceId}/selfie`, admin.token)).statusCode, 200);
  assert.equal((await db.query('SELECT id FROM attendance WHERE duty_session_id=$1', [id])).rows.length, 2);
});
test('offline batches acknowledge individual outcomes, preserve accuracy and reject spoofed ownership', async () => {
  const user = await account(); const { id } = await start(user); const good = point(); const poor = point({ accuracy: 150 });
  const points = [good, poor, point({ latitude: 91 }), point({ recordedAt: new Date(Date.now() + 600000).toISOString() }), point({ mocked: true })];
  const response = await request('POST', '/api/duty/location', user.token, { dutySessionId: id, points });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().acknowledgments.map((a: { status: string }) => a.status), ['accepted', 'accepted', 'rejected', 'rejected', 'accepted']);
  assert.equal(response.json().acknowledgments[1].quality, 'POOR'); assert.equal(response.json().acknowledgments[4].quality, 'MOCKED');
  const retries = await Promise.all([1, 2].map(() => request('POST', '/api/duty/location', user.token, { dutySessionId: id, points: [good, poor] })));
  assert.ok(retries.every(r => r.json().acknowledgments.every((a: { status: string }) => a.status === 'duplicate')));
  const conflict = await request('POST', '/api/duty/location', user.token, { dutySessionId: id, points: [{ ...good, latitude: 34 }] });
  assert.equal(conflict.json().acknowledgments[0].code, 'POINT_ID_CONFLICT');
  assert.equal((await request('POST', '/api/duty/location', other.token, { dutySessionId: id, points: [point()] })).statusCode, 404);
  assert.equal((await request('POST', '/api/duty/location', user.token, { dutySessionId: id, fmoId: other.fmoId, points: [point()] })).statusCode, 400);
  assert.equal((await request('GET', `/api/fmos/${user.fmoId}/location`, other.token)).statusCode, 404);
  const location = await request('GET', `/api/fmos/${user.fmoId}/location`, admin.token);
  assert.equal(location.statusCode, 200); assert.ok(location.json().lastReliableLocation);
});
test('end duty is final and retry-safe; late offline points inside the collection window still synchronize', async () => {
  const user = await account(); const { id } = await start(user);
  const pending = point(); const finalLocation = point(); const stopped = new Date().toISOString();
  const input = { requestId: randomUUID(), dutySessionId: id, finalLocation, reportedStopTime: stopped };
  const result = await request('POST', '/api/duty/end', user.token, input);
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().trackingAuthorized, false);
  assert.equal(result.json().session.reportedStopTime, stopped);
  assert.equal((await request('POST', '/api/duty/end', user.token, input)).json().replayed, true);
  assert.equal((await request('GET', '/api/duty/current', user.token)).json().session, null);
  const sync = await request('POST', '/api/duty/location', user.token, { dutySessionId: id, points: [pending, finalLocation, point({ recordedAt: new Date(Date.parse(stopped) + 1000).toISOString() })] });
  assert.deepEqual(sync.json().acknowledgments.map((a: { status: string }) => a.status), ['accepted', 'duplicate', 'rejected']);
  assert.equal((await request('POST', '/api/duty/check-in/challenge', user.token, { dutySessionId: id })).statusCode, 409);
  assert.equal((await request('POST', '/api/duty/end', user.token, { ...input, requestId: randomUUID() })).statusCode, 409);
  assert.equal((await request('GET', `/api/fmos/${user.fmoId}/location`, admin.token)).statusCode, 200);
  await start(user);
});
test('route pagination returns every persisted point and scopes session ownership', async () => {
  const user = await account(); const { id } = await start(user);
  await request('POST', '/api/duty/location', user.token, { dutySessionId: id, points: Array.from({ length: 8 }, () => point()) });
  let cursor = '0'; const ids: string[] = []; let more = true;
  while (more) {
    const response = await request('GET', `/api/fmos/${user.fmoId}/route?dutySessionId=${id}&afterId=${cursor}&limit=3`, admin.token);
    assert.equal(response.statusCode, 200, response.body);
    ids.push(...response.json().points.map((p: { id: string }) => p.id));
    cursor = response.json().nextAfterId; more = response.json().hasMore;
  }
  assert.equal(ids.length, 9); assert.equal(new Set(ids).size, 9);
  assert.equal((await request('GET', `/api/fmos/${other.fmoId}/route?dutySessionId=${id}`, admin.token)).statusCode, 404);
});
test('FMO management, activation, password changes and settings changes are authorized and audited', async () => {
  const employeeCode = `NEW-${randomUUID().toUpperCase()}`;
  const input = { employeeCode, name: 'New Officer', password, phone: '03000000000' };
  assert.equal((await request('POST', '/api/fmos', officer.token, input)).statusCode, 403);
  const created = await request('POST', '/api/fmos', admin.token, input);
  assert.equal(created.statusCode, 201, created.body); const id = created.json().fmo.id;
  assert.equal((await request('POST', '/api/fmos', admin.token, input)).statusCode, 409);
  assert.equal((await request('PATCH', `/api/fmos/${id}`, admin.token, { isActive: false, phone: null })).statusCode, 200);
  assert.equal((await request('POST', '/api/auth/login', undefined, { employeeCode, password })).statusCode, 401);
  assert.equal((await request('PATCH', `/api/fmos/${id}`, admin.token, { isActive: true, name: 'Updated Officer' })).statusCode, 200);
  const settings = (await request('GET', '/api/settings', admin.token)).json().settings;
  const updated = { ...settings, dutyDurationMinutes: 360, trackingIntervalSeconds: 60 };
  assert.equal((await request('PUT', '/api/settings', officer.token, updated)).statusCode, 403);
  assert.equal((await request('PUT', '/api/settings', admin.token, { ...updated, automaticDutyEnd: true })).statusCode, 400);
  assert.equal((await request('PUT', '/api/settings', admin.token, updated)).statusCode, 200);
  const user = await account(); const duty = await start(user);
  assert.equal(duty.response.session.dutyDurationMinutes, 360);
  assert.equal((await request('PATCH', `/api/fmos/${user.fmoId}`, admin.token, { isActive: false })).statusCode, 409);
  await request('PUT', '/api/settings', admin.token, settings);
  const events = (await db.query("SELECT action FROM audit_logs WHERE action IN ('FMO_CREATED','FMO_UPDATED','SETTINGS_UPDATED')")).rows;
  assert.ok(events.length >= 4);
  const change = await account();
  assert.equal((await request('POST', '/api/auth/change-password', change.token, { currentPassword: password, newPassword: 'new-long-secure-password' })).statusCode, 200);
  assert.equal((await request('GET', '/api/auth/me', change.token)).statusCode, 401);
  assert.equal((await request('POST', '/api/auth/refresh', undefined, { refreshToken: change.refresh })).statusCode, 401);
});
test('dashboard summary reflects persisted data and rejects FMO access', async () => {
  const result = await request('GET', '/api/dashboard/summary', admin.token);
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(result.json().totalFmos >= 5); assert.ok(result.json().onDuty > 0);
  assert.ok(result.json().checkedIn > 0); assert.ok(result.json().completedDuty > 0);
  assert.equal((await request('GET', '/api/dashboard/summary', officer.token)).statusCode, 403);
});

test('old queued uploads do not make an offline officer appear current or move last location backward', async () => {
  const user = await account(); const id = randomUUID();
  await db.query(`INSERT INTO duty_sessions(id,fmo_id,start_request_id,start_time,expected_end_time,duty_duration_minutes,tracking_interval_seconds)
    VALUES ($1,$2,$3,now()-interval '1 hour',now()+interval '7 hours',480,45)`, [id, user.fmoId, randomUUID()]);
  const recent = point({ recordedAt: new Date(Date.now() - 20 * 60000).toISOString() });
  const older = point({ recordedAt: new Date(Date.now() - 30 * 60000).toISOString(), latitude: 31 });
  await request('POST', '/api/duty/location', user.token, { dutySessionId: id, points: [recent] });
  await request('POST', '/api/duty/location', user.token, { dutySessionId: id, points: [older] });
  const details = await request('GET', `/api/fmos/${user.fmoId}`, admin.token);
  assert.equal(details.statusCode, 200, details.body); assert.equal(details.json().status.tracking, 'OFFLINE');
  assert.equal(details.json().lastLocation.clientPointId, recent.clientPointId);
  assert.ok((await request('GET', '/api/dashboard/summary', admin.token)).json().offline > 0);
});

test('distinct concurrent starts create one active session; new points submitted concurrently are deduplicated', async () => {
  const user = await account();
  const inputs = [1, 2].map(() => ({ requestId: randomUUID(), location: point(), device: { installationId: randomUUID() } }));
  const results = await Promise.all(inputs.map(input => request('POST', '/api/duty/start', user.token, input)));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [201, 409]);
  const id = results.find(r => r.statusCode === 201)!.json().session.id;
  const input = { dutySessionId: id, points: [point()] };
  const locations = await Promise.all([1, 2].map(() => request('POST', '/api/duty/location', user.token, input)));
  assert.deepEqual(locations.map(r => r.json().acknowledgments[0].status).sort(), ['accepted', 'duplicate']);
});

test('GPS failure does not prevent ending duty, and the missing final fix is explicitly recorded', async () => {
  const user = await account(); const { id } = await start(user);
  const input = { requestId: randomUUID(), dutySessionId: id, finalLocation: null };
  assert.equal((await request('POST', '/api/duty/end', user.token, input)).statusCode, 400);
  const result = await request('POST', '/api/duty/end', user.token, { ...input, locationFailure: 'GPS_UNAVAILABLE' });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().session.endLocationFailure, 'GPS_UNAVAILABLE');
  assert.equal(result.json().finalLocation, null); assert.equal(result.json().trackingAuthorized, false);
});

test('API serves authenticated requests over an actual HTTP listener', async () => {
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`${url}/api/auth/me`, { headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(response.status, 200); assert.equal((await response.json() as { user: { role: string } }).user.role, 'SUPER_ADMIN');
  const anonymous = await fetch(`${url}/api/duty/current`); assert.equal(anonymous.status, 401); await anonymous.text();
});
