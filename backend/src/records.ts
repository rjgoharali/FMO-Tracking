import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { attendanceQuerySchema, resetAttendanceSchema, routeQuerySchema, sessionQuerySchema } from '../../packages/contracts/src/api.js';
import { deriveStatus } from '../../packages/contracts/src/index.js';
import { Auth, digest } from './auth.js';
import { one, audit, serverTime, type Database, type Db } from './db.js';
import { fail } from './errors.js';
import { getSettings } from './settings.js';
import { publicAttendance, publicDuty, publicLocation } from './presenters.js';
import { publicFmo, fmoColumns } from './admin.js';
import type { DutyRow, Principal } from './types.js';
import type { PrivateStorage } from './storage.js';
const idParam = z.object({ id: z.uuid() });
async function scopedFmo(db: Db, actor: Principal, id: string) {
  if (actor.role === 'FMO' && actor.fmoId !== id) fail(404, 'FMO_NOT_FOUND', 'FMO not found');
  const fmo = await one(db, `SELECT ${fmoColumns} FROM fmos f JOIN users u ON u.id=f.user_id WHERE f.id=$1`, [id]);
  if (!fmo) fail(404, 'FMO_NOT_FOUND', 'FMO not found');
  return fmo;
}
async function scopedAttendance(db: Db, actor: Principal, id: string) {
  const row = await one(db, `SELECT a.*,u.login_id,u.name,s.start_time,s.actual_end_time FROM attendance a JOIN fmos f ON f.id=a.fmo_id
    JOIN users u ON u.id=f.user_id JOIN duty_sessions s ON s.id=a.duty_session_id WHERE a.id=$1 AND ($2::uuid IS NULL OR a.fmo_id=$2)`, [id, actor.role === 'FMO' ? actor.fmoId : null]);
  if (!row) fail(404, 'ATTENDANCE_NOT_FOUND', 'Attendance record not found');
  return row;
}
export async function registerRecords(app: FastifyInstance, db: Database, auth: Auth, storage: PrivateStorage) {
  app.get('/api/attendance', { preHandler: auth.authenticate }, async request => {
    const query = attendanceQuerySchema.parse(request.query); const actor = request.principal!;
    if (actor.role === 'FMO' && query.fmoId && query.fmoId !== actor.fmoId) fail(403, 'FORBIDDEN', 'You may access only your own attendance');
    const settings = await getSettings(db);
    const now = await serverTime(db);
    const rows = await db.query(`SELECT a.*,u.login_id,u.name,s.start_time,s.actual_end_time,l.recorded_at AS last_recorded_at FROM attendance a
      JOIN fmos f ON f.id=a.fmo_id JOIN users u ON u.id=f.user_id JOIN duty_sessions s ON s.id=a.duty_session_id
      LEFT JOIN LATERAL (SELECT recorded_at FROM location_logs WHERE duty_session_id=s.id ORDER BY recorded_at DESC,id DESC LIMIT 1) l ON true
      WHERE ($1::uuid IS NULL OR a.fmo_id=$1) AND ($2::date IS NULL OR (a.check_in_time AT TIME ZONE $3)::date=$2)
      ORDER BY a.check_in_time DESC,a.id LIMIT $4 OFFSET $5`, [actor.role === 'FMO' ? actor.fmoId : query.fmoId ?? null, query.date ?? null, settings.timezone, query.limit + 1, query.offset]);
    return { items: rows.rows.slice(0, query.limit).map(row => ({ ...publicAttendance(row),
      trackingStatus: deriveStatus({ actualEndTime: row.actual_end_time ? String(row.actual_end_time) : null,
        checkInTime: String(row.check_in_time), lastRecordedAt: row.last_recorded_at ? String(row.last_recorded_at) : null }, settings, now).tracking,
      serverDurationSeconds: row.actual_end_time ? (new Date(String(row.actual_end_time)).getTime() - new Date(String(row.start_time)).getTime()) / 1000 : null,
    })), hasMore: rows.rows.length > query.limit };
  });
  app.get('/api/attendance/:id', { preHandler: auth.authenticate }, async request => {
    const { id } = idParam.parse(request.params); const row = await scopedAttendance(db, request.principal!, id);
    const session = await one<DutyRow>(db, 'SELECT * FROM duty_sessions WHERE id=$1', [row.duty_session_id]);
    return { attendance: publicAttendance(row), session: publicDuty(session!) };
  });
  app.get('/api/attendance/:id/selfie', { preHandler: auth.authenticate, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = idParam.parse(request.params); const row = await scopedAttendance(db, request.principal!, id);
    let image: Buffer;
    try { image = await storage.get(String(row.selfie_storage_key)); } catch { fail(503, 'SELFIE_UNAVAILABLE', 'Selfie storage is temporarily unavailable'); }
    if (digest(image) !== row.selfie_sha256) fail(503, 'SELFIE_INTEGRITY_ERROR', 'Stored selfie failed its integrity check');
    return reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'inline; filename="attendance-selfie"')
      .header('Cross-Origin-Resource-Policy', 'same-origin').type(String(row.selfie_mime_type)).send(image);
  });
  app.post('/api/attendance/:id/reset', { preHandler: auth.roles('ADMIN', 'SUPER_ADMIN') }, async request => {
    const { id } = idParam.parse(request.params); const { reason } = resetAttendanceSchema.parse(request.body); const actor = request.principal!;
    return db.transaction(async tx => {
      await auth.lockActor(tx, actor);
      const existing = await scopedAttendance(tx, actor, id);
      const session = await one<DutyRow>(tx, 'SELECT * FROM duty_sessions WHERE id=$1 FOR UPDATE', [existing.duty_session_id]);
      if (session!.status !== 'ACTIVE') fail(409, 'DUTY_COMPLETED', 'Completed duty attendance cannot be reset');
      const current = await one(tx, 'SELECT * FROM attendance WHERE id=$1 FOR UPDATE', [id]);
      if (current!.superseded_at) fail(409, 'ALREADY_RESET', 'This attendance was already reset');
      await tx.query('UPDATE attendance SET superseded_at=clock_timestamp(),superseded_by=$2,reset_reason=$3 WHERE id=$1', [id, actor.userId, reason]);
      await tx.query('UPDATE camera_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE duty_session_id=$1', [session!.id]);
      await audit(tx, actor.userId, 'ATTENDANCE_RESET', 'ATTENDANCE', id, { reason });
      return { success: true, requiresNewSelfie: true };
    });
  });
  app.get('/api/fmos/:id', { preHandler: auth.authenticate }, async request => {
    const { id } = idParam.parse(request.params); const fmo = await scopedFmo(db, request.principal!, id);
    const session = await one<DutyRow>(db, 'SELECT * FROM duty_sessions WHERE fmo_id=$1 ORDER BY start_time DESC LIMIT 1', [id]);
    const location = await one(db, 'SELECT * FROM location_logs WHERE fmo_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1', [id]);
    const attendance = session ? await one(db, 'SELECT * FROM attendance WHERE duty_session_id=$1 AND superseded_at IS NULL', [session.id]) : null;
    const settings = await getSettings(db);
    const status = deriveStatus(session ? { actualEndTime: session.actual_end_time?.toISOString() ?? null,
      checkInTime: attendance ? new Date(attendance.check_in_time as string).toISOString() : null,
      lastRecordedAt: location && location.duty_session_id === session.id ? new Date(location.recorded_at as string).toISOString() : null } : null, settings, await serverTime(db));
    return { fmo: publicFmo(fmo), session: session ? publicDuty(session) : null, attendance: attendance ? publicAttendance(attendance) : null,
      lastLocation: location ? publicLocation(location) : null, lastSeen: location?.recorded_at ?? null, status };
  });
  app.get('/api/fmos/:id/location', { preHandler: auth.authenticate }, async request => {
    const { id } = idParam.parse(request.params); await scopedFmo(db, request.principal!, id);
    const last = await one(db, 'SELECT * FROM location_logs WHERE fmo_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1', [id]);
    const reliable = await one(db, "SELECT * FROM location_logs WHERE fmo_id=$1 AND quality IN ('GOOD','ACCEPTABLE') ORDER BY recorded_at DESC,id DESC LIMIT 1", [id]);
    return { lastLocation: last ? publicLocation(last) : null, lastReliableLocation: reliable ? publicLocation(reliable) : null };
  });
  app.get('/api/fmos/:id/sessions', { preHandler: auth.authenticate }, async request => {
    const { id } = idParam.parse(request.params); await scopedFmo(db, request.principal!, id);
    const query = sessionQuerySchema.parse(request.query); const settings = await getSettings(db);
    const rows = await db.query<DutyRow>(`SELECT * FROM duty_sessions WHERE fmo_id=$1
      AND ($2::date IS NULL OR (start_time AT TIME ZONE $3)::date=$2) ORDER BY start_time DESC,id LIMIT $4 OFFSET $5`,
      [id, query.date ?? null, settings.timezone, query.limit + 1, query.offset]);
    return { items: rows.rows.slice(0, query.limit).map(publicDuty), hasMore: rows.rows.length > query.limit };
  });
  app.get('/api/fmos/:id/route', { preHandler: auth.authenticate }, async request => {
    const { id } = idParam.parse(request.params); await scopedFmo(db, request.principal!, id);
    const query = routeQuerySchema.parse(request.query);
    if (!await one(db, 'SELECT id FROM duty_sessions WHERE id=$1 AND fmo_id=$2', [query.dutySessionId, id])) fail(404, 'DUTY_NOT_FOUND', 'Duty session not found');
    const rows = await db.query(`SELECT * FROM location_logs WHERE duty_session_id=$1 AND fmo_id=$2 AND id>$3::bigint ORDER BY id LIMIT $4`,
      [query.dutySessionId, id, query.afterId, query.limit + 1]);
    const page = rows.rows.slice(0, query.limit);
    return { points: page.map(publicLocation), hasMore: rows.rows.length > query.limit, nextAfterId: page.length ? String(page.at(-1)!.id) : query.afterId,
      order: 'ingestion_id; sort complete route by recordedAt then id for display' };
  });
  app.get('/api/dashboard/summary', { preHandler: auth.roles('ADMIN', 'SUPER_ADMIN') }, async () => {
    const settings = await getSettings(db);
    // Count distinct officers, not sessions. Completion is for the organization date.
    const counts = await one(db, `WITH officer AS (
      SELECT f.id,s.id AS session_id,a.id AS attendance_id,l.recorded_at FROM fmos f JOIN users u ON u.id=f.user_id
      LEFT JOIN duty_sessions s ON s.fmo_id=f.id AND s.status='ACTIVE'
      LEFT JOIN attendance a ON a.duty_session_id=s.id AND a.superseded_at IS NULL
      LEFT JOIN LATERAL (SELECT recorded_at FROM location_logs WHERE duty_session_id=s.id ORDER BY recorded_at DESC,id DESC LIMIT 1) l ON true
      WHERE u.is_active)
      SELECT count(*)::int AS "totalFmos",count(session_id)::int AS "onDuty",count(attendance_id)::int AS "checkedIn",
      count(*) FILTER(WHERE session_id IS NOT NULL AND recorded_at>clock_timestamp()-$1*interval '1 second')::int AS "currentlyTracking",
      count(*) FILTER(WHERE session_id IS NOT NULL AND (recorded_at IS NULL OR recorded_at<=clock_timestamp()-$2*interval '1 second'))::int AS offline,
      count(*) FILTER(WHERE session_id IS NOT NULL AND recorded_at<=clock_timestamp()-$1*interval '1 second' AND recorded_at>clock_timestamp()-$2*interval '1 second')::int AS stale,
      (SELECT count(DISTINCT fmo_id)::int FROM duty_sessions WHERE status='COMPLETED' AND (actual_end_time AT TIME ZONE $3)::date=(clock_timestamp() AT TIME ZONE $3)::date) AS "completedDuty"
      FROM officer`, [settings.staleAfterSeconds, settings.offlineAfterSeconds, settings.timezone]);
    return { ...counts, timezone: settings.timezone, serverTime: await serverTime(db) };
  });
}
