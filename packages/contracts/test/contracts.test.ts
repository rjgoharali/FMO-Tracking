import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deriveStatus, locationBatchSchema, settingsSchema } from '../src/index.js';

const settings = settingsSchema.parse({ organizationName: 'Chakwal Field Operations', timezone: 'Asia/Karachi' });
const now = new Date('2026-09-19T10:00:00Z');
test('defaults define an eight-hour duty and sensible tracking thresholds', () => {
  assert.equal(settings.dutyDurationMinutes, 480);
  assert.equal(settings.trackingIntervalSeconds, 45);
  assert.equal(settings.automaticDutyEnd, false);
  assert.equal(settingsSchema.safeParse({ ...settings, offlineAfterSeconds: 120 }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, timezone: 'Invalid/Zone' }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, timezone: '+05:30' }).success, false);
});
test('start duty never implies check-in and completion stops freshness status', () => {
  assert.deepEqual(deriveStatus(null, settings, now), { duty: 'NOT_STARTED', tracking: 'NOT_STARTED' });
  const session = { actualEndTime: null, checkInTime: null, lastRecordedAt: now.toISOString() };
  assert.deepEqual(deriveStatus(session, settings, now), { duty: 'ON_DUTY', tracking: 'TRACKING' });
  assert.equal(deriveStatus({ ...session, checkInTime: now.toISOString() }, settings, now).duty, 'CHECKED_IN');
  assert.deepEqual(deriveStatus({ ...session, actualEndTime: now.toISOString() }, settings, now), { duty: 'COMPLETED', tracking: 'COMPLETED' });
});
test('freshness uses collection time and keeps attendance independent from offline state', () => {
  const session = { actualEndTime: null, checkInTime: '2026-09-19T08:00:00Z', lastRecordedAt: '2026-09-19T09:57:00Z' };
  assert.equal(deriveStatus(session, settings, now).tracking, 'NO_RECENT_LOCATION');
  assert.deepEqual(deriveStatus({ ...session, lastRecordedAt: '2026-09-19T09:50:00Z' }, settings, now), { duty: 'CHECKED_IN', tracking: 'OFFLINE' });
  assert.equal(deriveStatus({ ...session, lastRecordedAt: null }, settings, now).tracking, 'OFFLINE');
});
test('location contracts reject spoofed ownership, invalid GPS and oversized batches', () => {
  const point = { clientPointId: randomUUID(), latitude: 32.93, longitude: 72.85, accuracy: 8, recordedAt: now.toISOString() };
  const batch = { dutySessionId: randomUUID(), points: [point] };
  assert.equal(locationBatchSchema.safeParse(batch).success, true);
  assert.equal(locationBatchSchema.safeParse({ ...batch, fmoId: randomUUID() }).success, false);
  assert.equal(locationBatchSchema.safeParse({ ...batch, points: [{ ...point, latitude: 91 }] }).success, false);
  assert.equal(locationBatchSchema.safeParse({ ...batch, points: [{ ...point, accuracy: -1 }] }).success, false);
  assert.equal(locationBatchSchema.safeParse({ ...batch, points: Array(201).fill(point) }).success, false);
});
