import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createFmoSchema, updateFmoSchema, updateSettingsSchema, listQuerySchema } from '../../packages/contracts/src/api.js';
import { Auth } from './auth.js';
import { audit, one, type Database } from './db.js';
import { fail } from './errors.js';
import { hashPassword } from './password.js';
import { getSettings } from './settings.js';
const idParam = z.object({ id: z.uuid() });
export const fmoColumns = `f.id,u.id AS user_id,u.login_id AS employee_code,u.name,u.is_active,u.is_demo,f.phone,f.email,f.created_at`;
export function publicFmo(row: Record<string, unknown>) {
  return { id: row.id, employeeCode: row.employee_code, name: row.name, isActive: row.is_active, isDemo: row.is_demo,
    phone: row.phone, email: row.email, createdAt: row.created_at };
}
export async function registerAdmin(app: FastifyInstance, db: Database, auth: Auth) {
  const admin = auth.roles('ADMIN', 'SUPER_ADMIN');
  app.get('/api/settings', { preHandler: auth.authenticate }, async () => ({ settings: await getSettings(db) }));
  app.put('/api/settings', { preHandler: admin }, async request => {
    const settings = updateSettingsSchema.parse(request.body); const actor = request.principal!;
    await db.transaction(async tx => {
      await auth.lockActor(tx, actor);
      await tx.query('SELECT id FROM organization_settings WHERE id=1 FOR UPDATE');
      const before = await getSettings(tx);
      await tx.query(`UPDATE organization_settings SET organization_name=$1,timezone=$2,duty_duration_minutes=$3,tracking_interval_seconds=$4,
        stale_after_seconds=$5,offline_after_seconds=$6,gps_accuracy_threshold_meters=$7,automatic_duty_end=$8 WHERE id=1`,
        [settings.organizationName, settings.timezone, settings.dutyDurationMinutes, settings.trackingIntervalSeconds,
          settings.staleAfterSeconds, settings.offlineAfterSeconds, settings.gpsAccuracyThresholdMeters, settings.automaticDutyEnd]);
      await audit(tx, actor.userId, 'SETTINGS_UPDATED', 'ORGANIZATION_SETTINGS', '1', { before, after: settings });
    });
    return { settings };
  });
  app.get('/api/fmos', { preHandler: admin }, async request => {
    const query = listQuerySchema.parse(request.query);
    const rows = await db.query(`SELECT ${fmoColumns} FROM fmos f JOIN users u ON u.id=f.user_id
      WHERE ($1::text IS NULL OR position(lower($1) in lower(u.name || ' ' || u.login_id))>0)
      ORDER BY u.login_id LIMIT $2 OFFSET $3`, [query.search ?? null, query.limit + 1, query.offset]);
    return { items: rows.rows.slice(0, query.limit).map(publicFmo), hasMore: rows.rows.length > query.limit, offset: query.offset };
  });
  app.post('/api/fmos', { preHandler: admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = createFmoSchema.parse(request.body); const actor = request.principal!;
    const hash = await hashPassword(input.password);
    const result = await db.transaction(async tx => {
      await auth.lockActor(tx, actor);
      const user = await one<{ id: string }>(tx, "INSERT INTO users(login_id,name,role,password_hash) VALUES ($1,$2,'FMO',$3) RETURNING id", [input.employeeCode, input.name, hash]);
      const fmo = await one(tx, 'INSERT INTO fmos(user_id,phone,email) VALUES ($1,$2,$3) RETURNING id', [user!.id, input.phone ?? null, input.email ?? null]);
      await audit(tx, actor.userId, 'FMO_CREATED', 'FMO', String(fmo!.id));
      return publicFmo((await one(tx, `SELECT ${fmoColumns} FROM fmos f JOIN users u ON u.id=f.user_id WHERE f.id=$1`, [fmo!.id]))!);
    });
    reply.code(201); return { fmo: result };
  });
  app.patch('/api/fmos/:id', { preHandler: admin, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const { id } = idParam.parse(request.params); const input = updateFmoSchema.parse(request.body); const actor = request.principal!;
    const hash = input.password ? await hashPassword(input.password) : null;
    const result = await db.transaction(async tx => {
      await auth.lockActor(tx, actor);
      const fmo = await one<{ user_id: string }>(tx, 'SELECT user_id FROM fmos WHERE id=$1', [id]);
      if (!fmo) fail(404, 'FMO_NOT_FOUND', 'FMO not found');
      // Same user -> FMO -> session lock order as duty start and session revocation.
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [fmo.user_id]);
      await tx.query('SELECT id FROM fmos WHERE id=$1 FOR UPDATE', [id]);
      if (input.isActive === false && await one(tx, "SELECT id FROM duty_sessions WHERE fmo_id=$1 AND status='ACTIVE'", [id])) {
        fail(409, 'FMO_ON_DUTY', 'FMO must end the active duty before deactivation');
      }
      await tx.query(`UPDATE users SET name=COALESCE($2,name),is_active=COALESCE($3,is_active),password_hash=COALESCE($4,password_hash),
        auth_version=auth_version+CASE WHEN $4::text IS NOT NULL OR $3::boolean=false THEN 1 ELSE 0 END WHERE id=$1`, [fmo.user_id, input.name ?? null, input.isActive ?? null, hash]);
      await tx.query(`UPDATE fmos SET phone=CASE WHEN $2 THEN $3 ELSE phone END,email=CASE WHEN $4 THEN $5 ELSE email END WHERE id=$1`,
        [id, input.phone !== undefined, input.phone ?? null, input.email !== undefined, input.email ?? null]);
      if (hash || input.isActive === false) {
        await tx.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1', [fmo.user_id]);
        await tx.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1', [fmo.user_id]);
      }
      await audit(tx, actor.userId, 'FMO_UPDATED', 'FMO', id, { changedFields: Object.keys(input), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) });
      return publicFmo((await one(tx, `SELECT ${fmoColumns} FROM fmos f JOIN users u ON u.id=f.user_id WHERE f.id=$1`, [id]))!);
    });
    return { fmo: result };
  });
  app.post('/api/admin-users', { preHandler: auth.roles('SUPER_ADMIN'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = createFmoSchema.omit({ phone: true, email: true }).parse(request.body); const actor = request.principal!;
    const hash = await hashPassword(input.password);
    const user = await db.transaction(async tx => {
      await auth.lockActor(tx, actor);
      const row = await one(tx, "INSERT INTO users(login_id,name,role,password_hash) VALUES ($1,$2,'ADMIN',$3) RETURNING id,login_id,name,role", [input.employeeCode, input.name, hash]);
      await audit(tx, actor.userId, 'ADMIN_CREATED', 'USER', String(row!.id)); return row;
    });
    reply.code(201); return { user };
  });
  app.get('/api/audit-logs', { preHandler: auth.roles('SUPER_ADMIN') }, async request => {
    const query = listQuerySchema.omit({ search: true }).parse(request.query);
    const result = await db.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1 OFFSET $2', [query.limit + 1, query.offset]);
    return { items: result.rows.slice(0, query.limit), hasMore: result.rows.length > query.limit };
  });
}
