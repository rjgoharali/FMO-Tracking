import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrate, migrationsPath, type SqlClient } from '../runner.js';
import { seedDemo, validateSeedEnvironment } from '../seed/demo.js';

let db: SqlClient;
let close: () => Promise<void>;
let fixturePath: string;
const fakeHash = `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(128)}`;
before(async () => {
  fixturePath = await mkdtemp(join(tmpdir(), 'fmo-foundation-test-'));
  if (process.env.TEST_DATABASE_URL) {
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    db = { query: (sql, params) => client.query(sql, params), exec: sql => client.query(sql) };
    close = async () => { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); };
  } else {
    const client = new PGlite();
    db = client;
    close = () => client.close();
  }
  assert.deepEqual(await migrate(db), ['001_foundation.sql', '002_backend_workflows.sql']);
});
after(async () => {
  if (close) await close();
  // Only remove the specific generated test directory, never an arbitrary path.
  if (fixturePath && resolve(fixturePath).startsWith(resolve(tmpdir()) + sep + 'fmo-foundation-test-')) {
    await rm(fixturePath, { recursive: true, force: true });
  }
});
async function fmo() {
  const userId = randomUUID(); const fmoId = randomUUID();
  await db.query("INSERT INTO users(id, login_id, name, role, password_hash) VALUES ($1,$2,'Test Officer','FMO',$3)", [userId, `TEST-${randomUUID().toUpperCase()}`, fakeHash]);
  await db.query('INSERT INTO fmos(id,user_id) VALUES ($1,$2)', [fmoId, userId]);
  return fmoId;
}
async function session(fmoId: string) {
  const id = randomUUID();
  await db.query(`INSERT INTO duty_sessions(id,fmo_id,start_request_id,start_time,expected_end_time,duty_duration_minutes,tracking_interval_seconds)
    VALUES ($1,$2,$3,now() - interval '1 hour',now() + interval '7 hours',480,45)`, [id, fmoId, randomUUID()]);
  return id;
}
async function checkIn(id: string, fmoId: string) {
  return db.query(`INSERT INTO attendance(duty_session_id,fmo_id,check_in_request_id,selfie_storage_key,selfie_sha256,selfie_mime_type,latitude,longitude,accuracy)
    VALUES ($1,$2,$3,'private/test.jpg',$4,'image/jpeg',32.93,72.85,8) RETURNING id`, [id, fmoId, randomUUID(), 'c'.repeat(64)]);
}
async function location(id: string, fmoId: string, point = randomUUID(), time = new Date(Date.now() - 5000), latitude = 32.93) {
  return db.query(`INSERT INTO location_logs(duty_session_id,fmo_id,client_point_id,latitude,longitude,accuracy,recorded_at)
    VALUES ($1,$2,$3,$4,72.85,8,$5) ON CONFLICT(duty_session_id,client_point_id) DO NOTHING RETURNING id`, [id, fmoId, point, latitude, time]);
}

test('migration reruns are idempotent and settings are configurable with safe defaults', async () => {
  assert.deepEqual(await migrate(db), []);
  const result = await db.query('SELECT * FROM organization_settings');
  assert.equal(result.rows[0]!.duty_duration_minutes, 480);
  assert.equal(result.rows[0]!.tracking_interval_seconds, 45);
  assert.equal(result.rows[0]!.automatic_duty_end, false);
  await assert.rejects(db.query('UPDATE organization_settings SET offline_after_seconds = 100'));
});
test('migration checksum tampering is rejected and failed migrations roll back', async () => {
  const original = await readFile(new URL('001_foundation.sql', migrationsPath), 'utf8');
  await writeFile(join(fixturePath, '002_backend_workflows.sql'), await readFile(new URL('002_backend_workflows.sql', migrationsPath), 'utf8'));
  await writeFile(join(fixturePath, '001_foundation.sql'), original + '\n-- changed');
  const directory = pathToFileURL(fixturePath + sep);
  await assert.rejects(migrate(db, directory), /Applied migration changed/);
  await writeFile(join(fixturePath, '001_foundation.sql'), original);
  await writeFile(join(fixturePath, '003_broken.sql'), 'CREATE TABLE rollback_probe(id integer); SELECT nonexistent_column;');
  await assert.rejects(migrate(db, directory));
  assert.equal((await db.query("SELECT to_regclass('rollback_probe') AS table_name")).rows[0]!.table_name, null);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 2);
});
test('one active session per FMO and start duty is separate from attendance', async () => {
  const owner = await fmo(); const id = await session(owner);
  assert.equal((await db.query('SELECT * FROM attendance WHERE duty_session_id=$1', [id])).rows.length, 0);
  await assert.rejects(session(owner), /one_active_duty_per_fmo/);
  await checkIn(id, owner);
  await assert.rejects(checkIn(id, owner), /unique/);
});
test('attendance cannot exist without an active owned session', async () => {
  const owner = await fmo(); const other = await fmo(); const id = await session(owner);
  await assert.rejects(checkIn(randomUUID(), owner));
  await assert.rejects(checkIn(id, other));
  await db.query("UPDATE duty_sessions SET status='COMPLETED',actual_end_time=now(),end_request_id=$2 WHERE id=$1", [id, randomUUID()]);
  await assert.rejects(checkIn(id, owner));
  await assert.rejects(db.query("UPDATE duty_sessions SET status='ACTIVE',actual_end_time=NULL,end_request_id=NULL WHERE id=$1", [id]));
  await session(owner); // A new shift is allowed after completion.
});
test('duplicate queue retries persist each point once and keep its observation time', async () => {
  const owner = await fmo(); const id = await session(owner); const point = randomUUID();
  const recorded = new Date(Date.now() - 30 * 60000);
  assert.equal((await location(id, owner, point, recorded)).rows.length, 1);
  assert.equal((await location(id, owner, point, recorded)).rows.length, 0);
  const row = (await db.query('SELECT recorded_at,received_at FROM location_logs WHERE duty_session_id=$1', [id])).rows[0]!;
  assert.equal(new Date(row.recorded_at as string).getTime(), recorded.getTime());
  assert.ok(new Date(row.received_at as string).getTime() > recorded.getTime());
});
test('GPS validation and ownership constraints reject invalid points', async () => {
  const owner = await fmo(); const id = await session(owner);
  await assert.rejects(location(id, await fmo()));
  await assert.rejects(location(id, owner, randomUUID(), new Date(), 91));
  await assert.rejects(location(id, owner, randomUUID(), new Date(), NaN));
  await assert.rejects(location(id, owner, randomUUID(), new Date(Date.now() + 3600000)));
  await assert.rejects(location(id, owner, randomUUID(), new Date(Date.now() - 7200000)));
});
test('late offline points within the duty window remain accepted after completion', async () => {
  const owner = await fmo(); const id = await session(owner);
  await db.query("UPDATE duty_sessions SET status='COMPLETED',actual_end_time=now()-interval '5 minutes',end_request_id=$2 WHERE id=$1", [id, randomUUID()]);
  assert.equal((await location(id, owner, randomUUID(), new Date(Date.now() - 10 * 60000))).rows.length, 1);
  await assert.rejects(location(id, owner, randomUUID(), new Date()));
  assert.equal((await db.query('SELECT * FROM location_logs WHERE duty_session_id=$1', [id])).rows.length, 1);
});
test('history cannot be accidentally overwritten or deleted', async () => {
  const owner = await fmo(); const id = await session(owner);
  await location(id, owner);
  await assert.rejects(db.query('DELETE FROM location_logs WHERE duty_session_id=$1', [id]), /append-only/);
  await assert.rejects(db.query('UPDATE location_logs SET accuracy=10 WHERE duty_session_id=$1', [id]), /append-only/);
  await assert.rejects(db.query('DELETE FROM duty_sessions WHERE id=$1', [id]), /append-only/);
  await db.query("INSERT INTO audit_logs(action,entity_type) VALUES ('TEST','SYSTEM')");
  await assert.rejects(db.query("DELETE FROM audit_logs WHERE action='TEST'"), /append-only/);
});
test('password storage and FMO user roles are constrained', async () => {
  await assert.rejects(db.query("INSERT INTO users(login_id,name,role,password_hash) VALUES ('BAD','Bad','FMO','plain-password')"));
  const id = randomUUID();
  await db.query("INSERT INTO users(id,login_id,name,role,password_hash) VALUES ($1,'TEST-ADMIN','Admin','ADMIN',$2)", [id, fakeHash]);
  await assert.rejects(db.query('INSERT INTO fmos(user_id) VALUES ($1)', [id]));
});
test('demo seed requires explicit development consent and creates distinct marked records once', async () => {
  assert.throws(() => validateSeedEnvironment({ NODE_ENV: 'production', ALLOW_DEMO_SEED: 'true' }));
  assert.throws(() => validateSeedEnvironment({ NODE_ENV: 'development', ALLOW_DEMO_SEED: 'false' }));
  const credentials = validateSeedEnvironment({ NODE_ENV: 'development', ALLOW_DEMO_SEED: 'true', SEED_ADMIN_PASSWORD: 'test-admin-password', SEED_FMO_PASSWORD: 'test-fmo-password' });
  const options = { ...credentials, storagePath: fixturePath };
  assert.equal((await seedDemo(db, options)).seeded, true);
  assert.equal((await seedDemo(db, options)).seeded, false);
  const users = await db.query('SELECT password_hash FROM users WHERE is_demo=true');
  assert.equal(users.rows.length, 6);
  assert.equal(new Set(users.rows.map(u => u.password_hash)).size, 6);
  assert.equal((await db.query('SELECT * FROM attendance WHERE is_demo=true')).rows.length, 3);
  assert.equal((await db.query('SELECT * FROM location_logs WHERE is_demo=true')).rows.length, 48);
  assert.equal((await db.query("SELECT * FROM audit_logs WHERE action='DEMO_SEEDED'")).rows.length, 1);
  assert.equal((await readFile(join(fixturePath, 'demo/placeholder-not-a-selfie.png'))).subarray(1, 4).toString(), 'PNG');
});
