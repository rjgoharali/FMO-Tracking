import { before, after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config.js';
import { Auth } from '../src/auth.js';
import { hashPassword } from '../src/password.js';
import type { UserRow } from '../src/types.js';
import type { Database } from '../src/db.js';
import { testDatabase } from './helpers.js';

let app: FastifyInstance, db: Database, close: () => Promise<void>, url: string, auth: Auth, passwordHash: string;
const sockets: Socket[] = [];
const origin = 'http://localhost:3000';
const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', JWT_SECRET: 'phase-four-test-secret-'.repeat(4), CORS_ORIGINS: origin });
type Account = { id: string; fmoId: string | null; token: string; sessionId: string };
async function account(role: 'FMO' | 'ADMIN' | 'SUPER_ADMIN' = 'FMO') {
  const id = randomUUID(), fmoId = role === 'FMO' ? randomUUID() : null, sessionId = randomUUID();
  await db.query("INSERT INTO users(id,login_id,name,role,password_hash,is_demo) VALUES ($1,$2,'Socket test officer',$3,$4,true)", [id, 'SOCKET-' + id.toUpperCase(), role, passwordHash]);
  if (fmoId) await db.query('INSERT INTO fmos(id,user_id) VALUES ($1,$2)', [fmoId, id]);
  await db.query("INSERT INTO auth_sessions(id,user_id,client_type,expires_at) VALUES ($1,$2,'mobile',now()+interval '1 day')", [sessionId, id]);
  return { id, fmoId, sessionId, token: await auth.accessToken({ id, auth_version: 1 } as UserRow, sessionId) };
}
function connected(token?: string, allowedOrigin: string | null = origin) {
  const socket = io(url, { transports: ['websocket'], autoConnect: false, reconnection: false, timeout: 3000, auth: token ? { token } : {}, ...(allowedOrigin ? { extraHeaders: { Origin: allowedOrigin } } : {}) }); sockets.push(socket); return socket;
}
function event<T = unknown>(socket: Socket, name: string, predicate: (value: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const listener = (value: T) => { if (predicate(value)) { clearTimeout(timer); socket.off(name, listener); resolve(value); } };
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error('Timed out waiting for ' + name)); }, 5000); socket.on(name, listener);
  });
}
async function connect(token: string) { const socket = connected(token); const ready = event(socket, 'connect'); socket.connect(); await ready; return socket; }
function point(recordedAt = new Date().toISOString()) { return { clientPointId: randomUUID(), latitude: 32.94, longitude: 72.86, accuracy: 8, recordedAt }; }
let ip = 1;
async function request(method: 'GET' | 'POST', path: string, actor?: Account, payload?: object) {
  return app.inject({ method, url: path, headers: actor ? { authorization: 'Bearer ' + actor.token } : {}, ...(payload ? { payload } : {}), remoteAddress: '10.9.0.' + ip++ });
}
async function start(actor: Account) { const response = await request('POST', '/api/duty/start', actor, { requestId: randomUUID(), device: { installationId: randomUUID() }, location: point() }); assert.equal(response.statusCode, 201, response.body); return response.json().session.id as string; }
before(async () => {
  ({ db, close } = await testDatabase()); auth = new Auth(db, env); passwordHash = await hashPassword('socket-test-only-password');
  app = await buildApp(env, async () => true, { db, storage: { put: async () => undefined, get: async () => Buffer.alloc(0) } });
  url = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(() => { for (const socket of sockets.splice(0)) socket.disconnect(); });
after(async () => { if (app) await app.close(); if (close) await close(); });

test('tracking snapshot denies unauthenticated/FMO access and paginates without duplicate officers', async () => {
  const admin = await account('ADMIN'), fmo = await account(); await account();
  assert.equal((await request('GET', '/api/tracking/snapshot')).statusCode, 401);
  assert.equal((await request('GET', '/api/tracking/snapshot', fmo)).statusCode, 403);
  const first = await request('GET', '/api/tracking/snapshot?limit=1', admin); assert.equal(first.statusCode, 200, first.body);
  const page = first.json(); assert.equal(page.items.length, 1); assert.equal(page.hasMore, true); assert.equal(page.items[0].fmo.isDemo, true); assert.equal(page.items[0].session, null);
  const next = (await request('GET', '/api/tracking/snapshot?limit=1&afterId=' + page.nextAfterId, admin)).json(); assert.notEqual(next.items[0].fmo.id, page.items[0].fmo.id);
  assert.equal(first.body.includes('password'), false); assert.equal(first.body.includes('test-fixture-not-a-login-hash'), false);
});
test('real websocket handshake rejects missing tokens, FMOs, untrusted and missing origins', async () => {
  const fmo = await account(), admin = await account('ADMIN');
  for (const [token, requestOrigin] of [[undefined, origin], [fmo.token, origin], [admin.token, 'https://untrusted.invalid'], [admin.token, null]] as const) {
    const socket = connected(token, requestOrigin); const rejected = event(socket, 'connect_error'); socket.connect(); await rejected; assert.equal(socket.connected, false); socket.disconnect();
  }
});
test('a committed location updates an authenticated admin socket and retains newer observations on late uploads', async () => {
  const admin = await account('ADMIN'), fmo = await account(); const session = await start(fmo); const socket = await connect(admin.token);
  const next = event<any>(socket, 'tracking:update', data => data.items.some((row: any) => row.fmo.id === fmo.fmoId && row.lastLocation?.latitude === 33.125));
  const observed = { ...point(), latitude: 33.125 };
  const response = await request('POST', '/api/duty/location', fmo, { dutySessionId: session, points: [observed] }); assert.equal(response.statusCode, 200, response.body);
  const update = await next; const row = update.items.find((item: any) => item.fmo.id === fmo.fmoId); assert.equal(row.lastLocation.latitude, observed.latitude); assert.equal(row.attendance, null); assert.equal(row.status.duty, 'ON_DUTY'); assert.equal(row.status.tracking, 'TRACKING');
  const later = event<any>(socket, 'tracking:update', data => data.items.some((item: any) => item.fmo.id === fmo.fmoId));
  await request('POST', '/api/duty/location', fmo, { dutySessionId: session, points: [{ ...point(new Date(Date.parse(observed.recordedAt) - 1000).toISOString()), latitude: 31 }] });
  const retained = (await later).items.find((item: any) => item.fmo.id === fmo.fmoId); assert.equal(retained.lastLocation.latitude, observed.latitude);
});
test('revoked admin receives no further location payload and is disconnected before publication', async () => {
  const admin = await account('ADMIN'), fmo = await account(); const session = await start(fmo); const socket = await connect(admin.token);
  await db.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [admin.sessionId]);
  let received = 0; socket.on('tracking:update', () => received++); const disconnected = event(socket, 'disconnect');
  await request('POST', '/api/duty/location', fmo, { dutySessionId: session, points: [point()] }); await disconnected; assert.equal(received, 0);
});
test('completed duty update retains its last-known point and is no longer classified as tracking', async () => {
  const admin = await account('SUPER_ADMIN'), fmo = await account(); const session = await start(fmo), socket = await connect(admin.token);
  const completed = event<any>(socket, 'tracking:update', data => data.items.some((row: any) => row.fmo.id === fmo.fmoId && row.session?.status === 'COMPLETED'));
  const result = await request('POST', '/api/duty/end', fmo, { requestId: randomUUID(), dutySessionId: session, finalLocation: point() }); assert.equal(result.statusCode, 200, result.body);
  const row = (await completed).items.find((item: any) => item.fmo.id === fmo.fmoId); assert.ok(row.lastLocation); assert.equal(row.status.tracking, 'COMPLETED'); assert.equal(row.status.duty, 'COMPLETED');
});

test('daily reports enforce admin access, include missing duty, and use organization-local start dates', async () => {
  const admin = await account('ADMIN'), fmo = await account();
  const path = '/api/reports/daily?date=2026-01-02&fmoId=' + fmo.fmoId;
  assert.equal((await request('GET', path, fmo)).statusCode, 403);
  assert.equal((await request('GET', path)).statusCode, 401);
  const missing = await request('GET', path, admin); assert.equal(missing.statusCode, 200, missing.body); assert.equal(missing.json().items[0].status.duty, 'NOT_STARTED');
  const id = randomUUID();
  await db.query("INSERT INTO duty_sessions(id,fmo_id,start_request_id,start_time,expected_end_time,duty_duration_minutes,tracking_interval_seconds,is_demo) VALUES ($1,$2,$3,'2026-01-01T23:30:00Z','2026-01-02T07:30:00Z',480,45,true)", [id, fmo.fmoId, randomUUID()]);
  const found = await request('GET', path, admin); assert.equal(found.json().items[0].dutySessionId, id); assert.equal(found.json().items[0].checkInTime, null); assert.equal(found.json().items[0].status.duty, 'ON_DUTY');
  const previous = await request('GET', path.replace('2026-01-02', '2026-01-01'), admin); assert.equal(previous.json().items[0].dutySessionId, null);
});
