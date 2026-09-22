import type { DutyRow } from './types.js';
export function publicDuty(row: DutyRow) {
  return { id: row.id, fmoId: row.fmo_id, deviceId: row.device_id, status: row.status,
    startTime: row.start_time, expectedEndTime: row.expected_end_time, actualEndTime: row.actual_end_time,
    reportedStopTime: row.reported_stop_time, endLocationFailure: row.end_location_failure ?? null, dutyDurationMinutes: row.duty_duration_minutes,
    trackingIntervalSeconds: row.tracking_interval_seconds, isDemo: row.is_demo,
    serverDurationSeconds: row.actual_end_time ? (new Date(row.actual_end_time).getTime() - new Date(row.start_time).getTime()) / 1000 : null,
    reportedDurationSeconds: row.reported_stop_time ? (new Date(row.reported_stop_time).getTime() - new Date(row.start_time).getTime()) / 1000 : null };
}
export function publicAttendance(row: Record<string, unknown>) {
  return { id: row.id, dutySessionId: row.duty_session_id, fmoId: row.fmo_id, checkInTime: row.check_in_time,
    latitude: row.latitude, longitude: row.longitude, accuracy: row.accuracy, captureMethod: row.capture_method,
    verificationStatus: row.verification_status, isDemo: row.is_demo, supersededAt: row.superseded_at,
    resetReason: row.reset_reason, selfiePath: `/api/attendance/${row.id}/selfie`, employeeCode: row.login_id, name: row.name,
    dutyStart: row.start_time, dutyEnd: row.actual_end_time };
}
export function publicLocation(row: Record<string, unknown>) {
  return { id: String(row.id), dutySessionId: row.duty_session_id, fmoId: row.fmo_id, clientPointId: row.client_point_id,
    latitude: row.latitude, longitude: row.longitude, accuracy: row.accuracy, speed: row.speed, batteryLevel: row.battery_level,
    recordedAt: row.recorded_at, deviceRecordedAt: row.device_recorded_at, receivedAt: row.received_at, quality: row.quality,
    mocked: row.is_mocked, isDemo: row.is_demo };
}
