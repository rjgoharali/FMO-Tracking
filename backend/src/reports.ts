import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from './db.js';
import { serverTime } from './db.js';
import type { Auth } from './auth.js';
import { getSettings } from './settings.js';
import { deriveStatus } from '../../packages/contracts/src/index.js';
export function registerReports(app: FastifyInstance, db: Database, auth: Auth) {
  app.get('/api/reports/daily', { preHandler: auth.roles('ADMIN', 'SUPER_ADMIN') }, async request => {
    const input = z.object({ date: z.iso.date(), fmoId: z.uuid().optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(request.query);
    const settings = await getSettings(db); const now = await serverTime(db);
    const result = await db.query(`SELECT f.id AS fmo_id,u.login_id,u.name,u.is_demo,s.id AS session_id,s.start_time,s.expected_end_time,s.actual_end_time,s.reported_stop_time,
      a.check_in_time,l.recorded_at,l.accuracy,l.quality FROM fmos f JOIN users u ON u.id=f.user_id
      LEFT JOIN duty_sessions s ON s.fmo_id=f.id AND (s.start_time AT TIME ZONE $2)::date=$1::date
      LEFT JOIN attendance a ON a.duty_session_id=s.id AND a.superseded_at IS NULL
      LEFT JOIN LATERAL (SELECT recorded_at,accuracy,quality FROM location_logs WHERE duty_session_id=s.id ORDER BY recorded_at DESC,id DESC LIMIT 1) l ON true
      WHERE (u.is_active OR s.id IS NOT NULL) AND ($3::uuid IS NULL OR f.id=$3)
      ORDER BY u.login_id,s.start_time,s.id LIMIT $4 OFFSET $5`, [input.date, settings.timezone, input.fmoId ?? null, input.limit + 1, input.offset]);
    return { date: input.date, timezone: settings.timezone, serverTime: now.toISOString(), hasMore: result.rows.length > input.limit,
      items: result.rows.slice(0, input.limit).map(row => ({ fmoId: row.fmo_id, employeeCode: row.login_id, name: row.name, isDemo: row.is_demo, dutySessionId: row.session_id,
        startTime: row.start_time, expectedEndTime: row.expected_end_time, checkInTime: row.check_in_time, actualEndTime: row.actual_end_time, reportedStopTime: row.reported_stop_time,
        serverDurationSeconds: row.actual_end_time ? (new Date(String(row.actual_end_time)).getTime() - new Date(String(row.start_time)).getTime()) / 1000 : null,
        reportedDurationSeconds: row.reported_stop_time ? (new Date(String(row.reported_stop_time)).getTime() - new Date(String(row.start_time)).getTime()) / 1000 : null,
        lastSeen: row.recorded_at, accuracy: row.accuracy, quality: row.quality,
        status: deriveStatus(row.session_id ? { actualEndTime: row.actual_end_time ? String(row.actual_end_time) : null, checkInTime: row.check_in_time ? String(row.check_in_time) : null, lastRecordedAt: row.recorded_at ? String(row.recorded_at) : null } : null, settings, now) })) };
  });
}
