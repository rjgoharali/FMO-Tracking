import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashPassword } from '../../backend/src/password.js';
import type { SqlClient } from '../runner.js';

// A transparent PNG fixture, deliberately not a person's face or identity evidence.
export const demoImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
export const demoImageKey = 'demo/placeholder-not-a-selfie.png';

export function validateSeedEnvironment(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV !== 'development' || env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Demo seed requires NODE_ENV=development and ALLOW_DEMO_SEED=true');
  }
  const adminPassword = env.SEED_ADMIN_PASSWORD ?? '';
  const fmoPassword = env.SEED_FMO_PASSWORD ?? '';
  if ([adminPassword, fmoPassword].some(p => p.length < 12 || Buffer.byteLength(p) > 1024)) {
    throw new Error('Set SEED_ADMIN_PASSWORD and SEED_FMO_PASSWORD to passwords of at least 12 characters (maximum 1024 bytes)');
  }
  return { adminPassword, fmoPassword };
}

export async function seedDemo(db: SqlClient, options: { adminPassword: string; fmoPassword: string; storagePath: string }) {
  const adminHash = await hashPassword(options.adminPassword);
  // Generate separate salts even though the development FMOs share a supplied password.
  const fmoHashes: string[] = [];
  for (let i = 0; i < 5; i++) fmoHashes.push(await hashPassword(options.fmoPassword));
  await db.exec('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(702641924)');
    const previous = await db.query("SELECT id FROM audit_logs WHERE action = 'DEMO_SEEDED'");
    if (previous.rows.length) { await db.exec('COMMIT'); return { seeded: false, reason: 'Demo already seeded; existing records preserved' }; }
    const collisions = await db.query("SELECT id FROM users WHERE login_id = 'DEMO-ADMIN' OR login_id = ANY($1::text[])",
      [Array.from({ length: 5 }, (_, i) => `CHK-FMO-00${i + 1}`)]);
    if (collisions.rows.length) throw new Error('Seed account IDs already exist; refusing to overwrite existing users');

    await mkdir(resolve(options.storagePath, 'demo'), { recursive: true });
    await writeFile(resolve(options.storagePath, demoImageKey), demoImage);
    const adminId = randomUUID();
    await db.query("INSERT INTO users(id, login_id, name, role, password_hash, is_demo) VALUES ($1, 'DEMO-ADMIN', 'Demo Administrator', 'SUPER_ADMIN', $2, true)", [adminId, adminHash]);
    const names = ['Muhammad Ayaz', 'Ahmed Raza', 'Bilal Ahmed', 'Usman Ali', 'Hassan Mahmood'];
    const clock = await db.query<{ server_now: Date | string }>('SELECT now() AS server_now');
    const now = new Date(clock.rows[0]!.server_now).getTime();
    for (let i = 0; i < 5; i++) {
      const userId = randomUUID(); const fmoId = randomUUID();
      await db.query("INSERT INTO users(id, login_id, name, role, password_hash, is_demo) VALUES ($1, $2, $3, 'FMO', $4, true)",
        [userId, `CHK-FMO-00${i + 1}`, `${names[i]} (DEMO)`, fmoHashes[i]]);
      await db.query('INSERT INTO fmos(id, user_id) VALUES ($1, $2)', [fmoId, userId]);
      if (i === 4) continue; // Fifth officer has not started duty.
      const sessionId = randomUUID();
      const start = now - (i === 3 ? 9 : 1) * 3600000;
      await db.query(`INSERT INTO duty_sessions(id, fmo_id, start_request_id, start_time, expected_end_time,
        duty_duration_minutes, tracking_interval_seconds, is_demo) VALUES ($1, $2, $3, $4, $5, 480, 45, true)`,
        [sessionId, fmoId, randomUUID(), new Date(start), new Date(start + 8 * 3600000)]);
      if (i !== 1) {
        await db.query(`INSERT INTO attendance(duty_session_id, fmo_id, check_in_request_id, check_in_time,
          selfie_storage_key, selfie_sha256, selfie_mime_type, latitude, longitude, accuracy, capture_method, is_demo)
          VALUES ($1, $2, $3, $4, $5, $6, 'image/png', 32.932, 72.855, 8, 'DEMO_FIXTURE', true)`,
          [sessionId, fmoId, randomUUID(), new Date(start + 5 * 60000), demoImageKey, createHash('sha256').update(demoImage).digest('hex')]);
      }
      const last = i === 3 ? start + 8 * 3600000 : now - (i === 2 ? 20 * 60000 : 10000);
      for (let point = 0; point < 12; point++) {
        await db.query(`INSERT INTO location_logs(duty_session_id, fmo_id, client_point_id, latitude, longitude,
          accuracy, speed, battery_level, recorded_at, is_demo) VALUES ($1, $2, $3, $4, $5, $6, 1.2, $7, $8, true)`,
          [sessionId, fmoId, randomUUID(), 32.932 + i * 0.002 + point * 0.0002,
            72.855 + point * 0.0003, point === 5 ? 150 : 8, 90 - point, new Date(start + ((last - start) * point / 11))]);
      }
      if (i === 3) await db.query("UPDATE duty_sessions SET status = 'COMPLETED', actual_end_time = $2, end_request_id = $3 WHERE id = $1",
        [sessionId, new Date(last + 60000), randomUUID()]);
    }
    await db.query("INSERT INTO audit_logs(actor_user_id, action, entity_type, metadata) VALUES ($1, 'DEMO_SEEDED', 'SYSTEM', $2)",
      [adminId, JSON.stringify({ demo: true, note: 'Synthetic locations and placeholder attendance image. Not real attendance.' })]);
    await db.exec('COMMIT');
    return { seeded: true, fmos: 5, admins: 1 };
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
}
