import { z } from 'zod';

export const settingsSchema = z.object({
  organizationName: z.string().trim().min(1).max(150),
  timezone: z.string().max(100).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Use an IANA timezone name such as Asia/Karachi'),
  dutyDurationMinutes: z.number().int().min(30).max(1440).default(480),
  trackingIntervalSeconds: z.number().int().min(30).max(300).default(45),
  staleAfterSeconds: z.number().int().min(60).max(3600).default(180),
  offlineAfterSeconds: z.number().int().min(120).max(86400).default(600),
  gpsAccuracyThresholdMeters: z.number().min(5).max(1000).default(100),
  automaticDutyEnd: z.boolean().default(false),
}).strict().refine(s => s.offlineAfterSeconds > s.staleAfterSeconds && s.staleAfterSeconds > s.trackingIntervalSeconds,
  'Offline threshold must exceed stale threshold, which must exceed the tracking interval');

export const locationPointSchema = z.object({
  clientPointId: z.uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().max(100000),
  recordedAt: z.iso.datetime({ offset: true }),
  speed: z.number().nonnegative().max(1000).nullable().optional(),
  batteryLevel: z.number().min(0).max(100).nullable().optional(),
  mocked: z.boolean().default(false),
}).strict();
export const locationBatchSchema = z.object({
  dutySessionId: z.uuid(), points: z.array(locationPointSchema).min(1).max(200),
}).strict();

export type Settings = z.infer<typeof settingsSchema>;
export type LocationPoint = z.infer<typeof locationPointSchema>;
export type DutyState = 'NOT_STARTED' | 'ON_DUTY' | 'CHECKED_IN' | 'COMPLETED';
export type TrackingState = 'NOT_STARTED' | 'TRACKING' | 'NO_RECENT_LOCATION' | 'OFFLINE' | 'COMPLETED';

// Lifecycle and tracking freshness are independent: start duty is never attendance.
// lastRecordedAt is a validated device observation time, not upload/heartbeat time.
export function deriveStatus(session: { actualEndTime: string | null; checkInTime: string | null; lastRecordedAt: string | null } | null,
  settings: Pick<Settings, 'staleAfterSeconds' | 'offlineAfterSeconds'>, now = new Date()) {
  if (!session) return { duty: 'NOT_STARTED', tracking: 'NOT_STARTED' } as const;
  if (session.actualEndTime) return { duty: 'COMPLETED', tracking: 'COMPLETED' } as const;
  const age = session.lastRecordedAt ? Math.max(0, (now.getTime() - Date.parse(session.lastRecordedAt)) / 1000) : Infinity;
  const tracking: TrackingState = !Number.isFinite(age) || age >= settings.offlineAfterSeconds ? 'OFFLINE'
    : age >= settings.staleAfterSeconds ? 'NO_RECENT_LOCATION' : 'TRACKING';
  const duty: DutyState = session.checkInTime ? 'CHECKED_IN' : 'ON_DUTY';
  return { duty, tracking };
}
