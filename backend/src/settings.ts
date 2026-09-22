import { settingsSchema, type Settings } from '../../packages/contracts/src/index.js';
import { one, type Db } from './db.js';
export async function getSettings(db: Db): Promise<Settings> {
  return settingsSchema.parse(await one(db, `SELECT organization_name AS "organizationName",timezone,
    duty_duration_minutes AS "dutyDurationMinutes",tracking_interval_seconds AS "trackingIntervalSeconds",
    stale_after_seconds AS "staleAfterSeconds",offline_after_seconds AS "offlineAfterSeconds",
    gps_accuracy_threshold_meters AS "gpsAccuracyThresholdMeters",automatic_duty_end AS "automaticDutyEnd" FROM organization_settings WHERE id=1`));
}
