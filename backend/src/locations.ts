import { locationPointSchema, type LocationPoint, type Settings } from '../../packages/contracts/src/index.js';
import type { PointAcknowledgment } from '../../packages/contracts/src/api.js';
import { one, type Db } from './db.js';
import { fingerprint } from './auth.js';
import type { DutyRow } from './types.js';
import { fail } from './errors.js';

export const pointFingerprint = (p: LocationPoint) => fingerprint({ clientPointId: p.clientPointId, latitude: p.latitude, longitude: p.longitude,
  accuracy: p.accuracy, recordedAt: new Date(p.recordedAt).toISOString(), speed: p.speed ?? null, batteryLevel: p.batteryLevel ?? null, mocked: p.mocked });
export function gpsQuality(p: LocationPoint, settings: Settings) {
  return p.mocked ? 'MOCKED' : p.accuracy > settings.gpsAccuracyThresholdMeters ? 'POOR' : p.accuracy <= 10 ? 'GOOD' : 'ACCEPTABLE';
}
export function requireFreshGps(p: LocationPoint, settings: Settings, time: Date) {
  if (p.mocked) fail(422, 'MOCK_LOCATION', 'Mock GPS is not accepted for duty start or attendance');
  if (p.accuracy > settings.gpsAccuracyThresholdMeters) fail(422, 'LOW_GPS_ACCURACY', 'GPS accuracy is too low. Move to an open area and try again');
  if (Math.abs(time.getTime() - Date.parse(p.recordedAt)) > 120000) fail(422, 'STALE_GPS', 'Capture a fresh location and check the device clock');
}
export async function ingestPoint(db: Db, session: DutyRow, raw: unknown, index: number, settings: Settings, now: Date): Promise<PointAcknowledgment> {
  const parsed = locationPointSchema.safeParse(raw);
  const rawId = raw && typeof raw === 'object' && 'clientPointId' in raw && typeof raw.clientPointId === 'string' ? raw.clientPointId.slice(0, 80) : null;
  const rejected = (code: string): PointAcknowledgment => ({ index, clientPointId: rawId, status: 'rejected', code });
  if (!parsed.success) return rejected('INVALID_POINT');
  const point = parsed.data; const hash = pointFingerprint(point);
  const previous = await one<{ payload_hash: string; quality: string }>(db, 'SELECT payload_hash,quality FROM location_logs WHERE duty_session_id=$1 AND client_point_id=$2', [session.id, point.clientPointId]);
  if (previous) return previous.payload_hash === hash ? { index, clientPointId: point.clientPointId, status: 'duplicate', quality: previous.quality } : rejected('POINT_ID_CONFLICT');
  const observed = Date.parse(point.recordedAt);
  if (observed > now.getTime() + 120000) return rejected('FUTURE_LOCATION');
  if (observed < new Date(session.start_time).getTime() - 120000) return rejected('BEFORE_DUTY');
  // Keep raw device time separately; small future clock skew is bounded at receipt.
  const effectiveTime = new Date(Math.min(observed, now.getTime()));
  const cutoff = session.reported_stop_time ?? session.actual_end_time;
  if (cutoff && effectiveTime.getTime() > new Date(cutoff).getTime()) return rejected('AFTER_DUTY');
  const quality = gpsQuality(point, settings);
  await db.query(`INSERT INTO location_logs(duty_session_id,fmo_id,client_point_id,latitude,longitude,accuracy,speed,battery_level,
    recorded_at,received_at,is_mocked,payload_hash,device_recorded_at,quality) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [session.id, session.fmo_id, point.clientPointId, point.latitude, point.longitude, point.accuracy, point.speed ?? null, point.batteryLevel ?? null,
      effectiveTime, now, point.mocked, hash, new Date(observed), quality]);
  return { index, clientPointId: point.clientPointId, status: 'accepted', quality };
}
