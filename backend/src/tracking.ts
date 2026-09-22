import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { deriveStatus } from '../../packages/contracts/src/index.js';
import type { Database } from './db.js';
import { serverTime } from './db.js';
import { getSettings } from './settings.js';
import { fmoColumns, publicFmo } from './admin.js';
import { publicAttendance, publicDuty, publicLocation } from './presenters.js';
import type { DutyRow } from './types.js';
import type { Auth } from './auth.js';

// One indexed query per page, not one HTTP/database round trip per map marker.
export async function trackingSnapshot(db: Database, options: { afterId?: string; limit?: number; fmoIds?: string[] } = {}) {
  const limit = options.limit ?? 200;
  const settings = await getSettings(db); const now = await serverTime(db);
  const result = await db.query(`SELECT ${fmoColumns},to_jsonb(s) AS duty,to_jsonb(a) AS attendance,to_jsonb(l) AS location
    FROM fmos f JOIN users u ON u.id=f.user_id
    LEFT JOIN LATERAL (SELECT * FROM duty_sessions WHERE fmo_id=f.id ORDER BY start_time DESC,id DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT * FROM attendance WHERE duty_session_id=s.id AND superseded_at IS NULL LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT * FROM location_logs WHERE fmo_id=f.id ORDER BY recorded_at DESC,id DESC LIMIT 1) l ON true
    WHERE u.is_active AND ($1::uuid IS NULL OR f.id>$1) AND ($2::uuid[] IS NULL OR f.id=ANY($2))
    ORDER BY f.id LIMIT $3`, [options.afterId ?? null, options.fmoIds ?? null, limit + 1]);
  const items = result.rows.slice(0, limit).map(row => {
    const duty = row.duty as DutyRow | null; const attendance = row.attendance as Record<string, unknown> | null; const location = row.location as Record<string, unknown> | null;
    const lastRecordedAt = duty && location?.duty_session_id === duty.id ? String(location.recorded_at) : null;
    return { fmo: publicFmo(row), session: duty ? publicDuty(duty) : null, attendance: attendance ? publicAttendance(attendance) : null,
      lastLocation: location ? publicLocation(location) : null, lastSeen: location?.recorded_at ?? null,
      status: deriveStatus(duty ? { actualEndTime: duty.actual_end_time ? String(duty.actual_end_time) : null,
        checkInTime: attendance ? String(attendance.check_in_time) : null, lastRecordedAt } : null, settings, now) };
  });
  return { items, settings, serverTime: now.toISOString(), hasMore: result.rows.length > limit, nextAfterId: items.at(-1)?.fmo.id ?? null };
}
export function registerTracking(app: FastifyInstance, db: Database, auth: Auth) {
  app.get('/api/tracking/snapshot', { preHandler: auth.roles('ADMIN', 'SUPER_ADMIN') }, async request => {
    const query = z.object({ afterId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).strict().parse(request.query);
    return trackingSnapshot(db, query);
  });
}
