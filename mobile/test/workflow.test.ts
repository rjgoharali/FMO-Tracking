import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Repository } from '../src/core/repository.ts';
import { SyncEngine } from '../src/core/sync.ts';
import { ApiClient, type Credentials, type Vault } from '../src/core/client.ts';
import { ApiFailure, initialSettings, type Duty, type Point, type Sql, type SqlDatabase, type Transport, type User, type Session } from '../src/core/types.ts';

const user: User = { id: 'user-one', fmoId: 'fmo-one', employeeCode: 'TEST-FMO', name: 'Test FMO', role: 'FMO', isDemo: true };
const session: Session = { id: 'session-one', fmoId: user.fmoId, startTime: new Date(Date.now() - 3600000).toISOString(), expectedEndTime: new Date(Date.now() + 25200000).toISOString(), actualEndTime: null, reportedStopTime: null, status: 'ACTIVE' };
const point = (): Point => ({ clientPointId: randomUUID(), latitude: 31, longitude: 73, accuracy: 8, recordedAt: new Date().toISOString(), mocked: false });
const duty = (): Duty => ({ key: randomUUID(), ownerId: user.id, fmoId: user.fmoId, phase: 'ACTIVE', canCollect: true, session, start: null, end: null, photo: null, attendance: null, settings: initialSettings, lastPoint: null, stopRequestedAt: null, issue: null, consentVersion: 'test' });
async function database(path = ':memory:') {
  const db = new DatabaseSync(path);
  const sql: Sql = { exec: async statement => { db.exec(statement); }, run: async (statement, ...params) => { db.prepare(statement).run(...params); }, all: async <T>(statement: string, ...params: (string | number | null)[]) => db.prepare(statement).all(...params) as T[] };
  let tail: Promise<unknown> = Promise.resolve();
  const adapter: SqlDatabase = { ...sql, transaction<T>(fn: (sql: Sql) => Promise<T>) {
    const task = tail.then(async () => { db.exec('BEGIN IMMEDIATE'); try { const value = await fn(sql); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } });
    tail = task.catch(() => undefined); return task;
  } };
  const repo = new Repository(adapter); await repo.init(); return { repo, close: () => db.close() };
}
function transport(handler: (path: string, body: any) => Promise<unknown>, selfie?: (job: any) => Promise<unknown>): Transport {
  return { json: async <T>(path: string, _method?: string, body?: unknown) => await handler(path, body) as T, selfie: async <T>(job: any) => { if (!selfie) throw new Error('Unexpected selfie upload'); return await selfie(job) as T; } };
}
function engine(repo: Repository, api: Transport) {
  const events = { stopped: 0, deleted: [] as string[] };
  return { events, sync: new SyncEngine(repo, api, { uuid: randomUUID, now: () => new Date().toISOString(), stopTracking: async () => { events.stopped++; }, deletePhoto: async uri => { events.deleted.push(uri); } }) };
}
const ack = (points: Point[], status = 'accepted') => ({ acknowledgments: points.map((p, index) => ({ index, clientPointId: p.clientPointId, status })), dutyStatus: 'ACTIVE', trackingIntervalSeconds: 45 });

test('SQLite outbox survives process reopen; duplicate point IDs and ownership stay isolated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fmo-mobile-test-')); const path = join(directory, 'queue.sqlite');
  let db = await database(path);
  try {
    await db.repo.create(duty()); const points = Array.from({ length: 125 }, point);
    await db.repo.append(user.id, points); await db.repo.append(user.id, points);
    db.close(); db = await database(path);
    assert.equal((await db.repo.counts(user.id)).pending, 125);
    assert.equal((await db.repo.pending('another-user')).length, 0);
    assert.equal((await db.repo.pending(user.id))[0]!.id, points[0]!.clientPointId);
  } finally { db.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true }); }
});
test('durable stop gate rejects late callbacks and permits only one unfinished duty', async () => {
  const db = await database(); try {
    const local = duty(); await db.repo.create(local); await assert.rejects(db.repo.create(duty()));
    await db.repo.update(local.key, d => ({ ...d, phase: 'ENDING', canCollect: false }));
    assert.equal(await db.repo.append(user.id, [point()]), 0); assert.equal((await db.repo.counts(user.id)).pending, 0);
  } finally { db.close(); }
});
test('invalid batch acknowledgment deletes nothing; rejection remains available for review', async () => {
  const db = await database(); try {
    await db.repo.create(duty()); await db.repo.append(user.id, [point(), point()]); const sent = await db.repo.pending(user.id);
    await assert.rejects(db.repo.acknowledge(user.id, session.id, sent, [{ index: 0, clientPointId: sent[0]!.id, status: 'accepted' }, { index: 1, clientPointId: 'wrong-id', status: 'accepted' }]));
    assert.equal((await db.repo.counts(user.id)).pending, 2);
    await db.repo.acknowledge(user.id, session.id, sent, [{ index: 0, clientPointId: sent[0]!.id, status: 'duplicate' }, { index: 1, clientPointId: sent[1]!.id, status: 'rejected', code: 'OUTSIDE_SESSION' }]);
    assert.deepEqual(await db.repo.counts(user.id), { pending: 0, rejected: 1 }); assert.equal((await db.repo.rejected(user.id))[0]!.reason, 'OUTSIDE_SESSION');
  } finally { db.close(); }
});
test('lost server response retries stable IDs and synchronizes without duplicate records', async () => {
  const db = await database(); try {
    await db.repo.create(duty()); await db.repo.append(user.id, [point(), point()]); const server = new Set<string>(); let fail = true;
    const { sync } = engine(db.repo, transport(async (_path, body) => { const points: Point[] = body.points; points.forEach(p => server.add(p.clientPointId)); if (fail) { fail = false; throw new ApiFailure(0, 'OFFLINE', 'Offline'); } return ack(points, 'duplicate'); }));
    await assert.rejects(sync.synchronize(user)); assert.equal((await db.repo.counts(user.id)).pending, 2); assert.equal((await db.repo.current(user.id))!.canCollect, true);
    await sync.synchronize(user); assert.equal(server.size, 2); assert.equal((await db.repo.counts(user.id)).pending, 0);
  } finally { db.close(); }
});
test('start request retries unchanged and never confirms attendance or starts native tracking', async () => {
  const db = await database(); try {
    const local = duty(); local.phase = 'START_PENDING'; local.canCollect = false; local.session = null;
    local.start = { requestId: local.key, location: point(), device: { installationId: randomUUID() } }; await db.repo.create(local);
    const requests: unknown[] = []; const { sync, events } = engine(db.repo, transport(async (path, body) => { assert.equal(path, '/api/duty/start'); requests.push(body); if (requests.length === 1) throw new ApiFailure(0, 'OFFLINE', 'Offline'); return { session }; }));
    await assert.rejects(sync.synchronize(user)); await sync.synchronize(user); assert.deepEqual(requests[0], requests[1]);
    const current = await db.repo.current(user.id); assert.equal(current!.phase, 'PAUSED'); assert.equal(current!.attendance, null); assert.equal(current!.canCollect, false); assert.equal(events.stopped, 0);
  } finally { db.close(); }
});
test('offline end uploads retained points before finalization and reconciliation never reopens the gate', async () => {
  const db = await database(); try {
    const local = duty(); await db.repo.create(local); await db.repo.append(user.id, [point()]);
    const end = { requestId: randomUUID(), dutySessionId: session.id, finalLocation: null, locationFailure: 'GPS_UNAVAILABLE' as const, reportedStopTime: new Date().toISOString() };
    await db.repo.update(local.key, d => ({ ...d, phase: 'ENDING', canCollect: false, end, stopRequestedAt: end.reportedStopTime })); const paths: string[] = [];
    const { sync, events } = engine(db.repo, transport(async (path, body) => { paths.push(path); if (path === '/api/duty/current') return { session, settings: initialSettings, trackingAuthorized: true }; if (path === '/api/duty/location') return ack(body.points); assert.deepEqual(body, end); return { session: { ...session, status: 'COMPLETED', actualEndTime: new Date().toISOString() } }; }));
    await sync.reconcile(user); assert.equal((await db.repo.current(user.id))!.canCollect, false);
    await sync.synchronize(user); assert.deepEqual(paths, ['/api/duty/current', '/api/duty/location', '/api/duty/end']); assert.equal((await db.repo.current(user.id))!.phase, 'COMPLETED'); assert.equal(events.stopped, 1);
  } finally { db.close(); }
});
test('crash during stop recovers to end with GPS failure, never resumes collection', async () => {
  const db = await database(); try {
    const local = duty(); local.phase = 'STOPPING'; local.canCollect = false; local.stopRequestedAt = new Date(Date.now() - 120000).toISOString(); await db.repo.create(local);
    const { sync, events } = engine(db.repo, transport(async (path, body) => { assert.equal(path, '/api/duty/end'); assert.equal(body.locationFailure, 'GPS_UNAVAILABLE'); assert.equal(body.reportedStopTime, local.stopRequestedAt); return { session: { ...session, status: 'COMPLETED' } }; }));
    await sync.synchronize(user); assert.equal((await db.repo.current(user.id))!.phase, 'COMPLETED'); assert.equal(events.stopped, 2);
  } finally { db.close(); }
});
test('pending live selfie retries identical evidence, deleting private copy only after confirmation', async () => {
  const db = await database(); try {
    const local = duty(); local.photo = { uri: 'private-test-photo.jpg', metadata: { requestId: randomUUID(), dutySessionId: session.id, challengeToken: 'test-only', location: point() }, blocked: false, error: null }; await db.repo.create(local); const uploads: unknown[] = [];
    const attendance = { id: randomUUID(), dutySessionId: session.id, checkInTime: new Date().toISOString(), accuracy: 8, verificationStatus: 'NOT_VERIFIED' };
    const { sync, events } = engine(db.repo, transport(async () => { throw new Error('Unexpected JSON request'); }, async job => { uploads.push(job); if (uploads.length === 1) throw new ApiFailure(0, 'OFFLINE', 'Offline'); return { attendance }; }));
    await assert.rejects(sync.synchronize(user)); assert.deepEqual(events.deleted, []); await sync.synchronize(user); assert.deepEqual(uploads[0], uploads[1]); assert.deepEqual(events.deleted, ['private-test-photo.jpg']); assert.equal((await db.repo.current(user.id))!.attendance!.id, attendance.id);
  } finally { db.close(); }
});
test('unconfirmed selfie is never submitted after a local end; evidence is retained', async () => {
  const db = await database(); try {
    const local = duty(); local.phase = 'ENDING'; local.canCollect = false; local.photo = { uri: 'private.jpg', metadata: { requestId: randomUUID(), dutySessionId: session.id, challengeToken: 'test', location: point() }, blocked: false, error: null }; await db.repo.create(local);
    const { sync } = engine(db.repo, transport(async () => ({ session, attendance: null })));
    await sync.synchronize(user); assert.equal((await db.repo.current(user.id))!.photo!.blocked, true);
  } finally { db.close(); }
});
test('confirmed authorization revocation pauses tracking; ordinary outage preserves collection', async () => {
  for (const status of [0, 401]) {
    const db = await database(); try {
      await db.repo.create(duty()); await db.repo.append(user.id, [point()]); const { sync, events } = engine(db.repo, transport(async () => { throw new ApiFailure(status, 'TEST', 'Test failure'); }));
      await assert.rejects(sync.synchronize(user)); assert.equal((await db.repo.current(user.id))!.canCollect, status === 0); assert.equal(events.stopped, status === 401 ? 1 : 0); assert.equal((await db.repo.counts(user.id)).pending, 1);
    } finally { db.close(); }
  }
});
test('uncertain refresh rotation is never replayed and requires same-account sign in', async () => {
  const db = await database(); try {
    let stored: Credentials | null = { user, accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 0, refreshing: false }; let requests = 0;
    const vault: Vault = { read: async () => stored, save: async value => { stored = value; }, clear: async () => { stored = null; } };
    const client = new ApiClient({ baseUrl: 'https://example.invalid', repo: db.repo, vault, uuid: randomUUID, photoBody: () => new FormData(), fetch: async () => { requests++; throw new Error('Response lost after rotation'); } });
    await assert.rejects(client.json('/api/duty/current'), (error: unknown) => error instanceof ApiFailure && error.status === 0);
    await assert.rejects(client.json('/api/duty/current')); assert.equal(requests, 1); assert.equal(stored!.needsLogin, 'uncertain'); assert.equal(stored!.refreshToken, '');
  } finally { db.close(); }
});

test('server tracking denial closes collection gate during reconciliation', async () => {
  const db = await database(); try {
    await db.repo.create(duty()); const { sync, events } = engine(db.repo, transport(async () => ({ session, settings: initialSettings, trackingAuthorized: false })));
    await sync.reconcile(user); assert.equal((await db.repo.current(user.id))!.canCollect, false); assert.equal(events.stopped, 1);
  } finally { db.close(); }
});
test('active duty prevents account switching and logout without losing saved credentials', async () => {
  const db = await database(); try {
    await db.repo.create(duty());
    let stored: Credentials | null = { user, accessToken: 'test', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000, refreshing: false };
    const vault: Vault = { read: async () => stored, save: async value => { stored = value; }, clear: async () => { stored = null; } };
    const calls: string[] = [];
    const client = new ApiClient({ baseUrl: 'https://example.invalid', repo: db.repo, vault, uuid: randomUUID, photoBody: () => new FormData(), fetch: async (url, options) => {
      calls.push(String(url)); if (String(url).endsWith('/login')) { assert.deepEqual(JSON.parse(options!.body as string), { employeeCode: 'OTHER', password: 'test-password', client: 'mobile' }); return Response.json({ user: { ...user, id: 'another-user' }, accessToken: 'other', refreshToken: 'other-refresh', expiresIn: 900 }); }
      return Response.json({ success: true });
    } });
    await assert.rejects(client.login('OTHER', 'test-password'), (error: unknown) => error instanceof ApiFailure && error.code === 'PENDING_OTHER_ACCOUNT');
    assert.equal(stored!.user.id, user.id); assert.equal(calls.length, 2); await assert.rejects(client.logout()); assert.equal(calls.length, 2); assert.ok(stored);
  } finally { db.close(); }
});
test('successful login uses the mobile API contract and authenticated requests use bearer tokens', async () => {
  const db = await database(); try {
    let stored: Credentials | null = null;
    const vault: Vault = { read: async () => stored, save: async value => { stored = value; }, clear: async () => { stored = null; } };
    const client = new ApiClient({ baseUrl: 'https://example.invalid', repo: db.repo, vault, uuid: randomUUID, photoBody: () => new FormData(), fetch: async (url, options) => {
      if (String(url).endsWith('/login')) return Response.json({ user, accessToken: 'test-token', refreshToken: 'test-refresh', expiresIn: 900 });
      assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer test-token'); return Response.json({ success: true });
    } });
    assert.deepEqual(await client.login(user.employeeCode, 'test-only'), user); assert.equal(await db.repo.value('owner'), user.id);
    await client.logout(); assert.equal(stored, null); assert.equal(await db.repo.value('profile'), '');
  } finally { db.close(); }
});
test('sync lease prevents overlapping consumers from submitting the same batch concurrently', async () => {
  const db = await database(); try {
    await db.repo.create(duty()); await db.repo.append(user.id, [point()]); let requests = 0;
    const { sync } = engine(db.repo, transport(async (_path, body) => { requests++; return ack(body.points); }));
    await db.repo.lease('sync', 'another-consumer', Date.now(), 60000); await sync.synchronize(user); assert.equal(requests, 0);
    await db.repo.release('sync', 'another-consumer'); await sync.synchronize(user); assert.equal(requests, 1);
  } finally { db.close(); }
});
