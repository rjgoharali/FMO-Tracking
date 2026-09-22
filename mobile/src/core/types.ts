export type User = { id: string; employeeCode: string; name: string; role: 'FMO'; fmoId: string; isDemo: boolean };
export type Point = { clientPointId: string; latitude: number; longitude: number; accuracy: number; recordedAt: string; speed?: number | null; batteryLevel?: number | null; mocked: boolean };
export type Settings = { organizationName: string; timezone: string; dutyDurationMinutes: number; trackingIntervalSeconds: number; staleAfterSeconds: number; offlineAfterSeconds: number; gpsAccuracyThresholdMeters: number; automaticDutyEnd: boolean };
export const initialSettings: Settings = { organizationName: 'Field Operations', timezone: 'Asia/Karachi', dutyDurationMinutes: 480, trackingIntervalSeconds: 45, staleAfterSeconds: 180, offlineAfterSeconds: 600, gpsAccuracyThresholdMeters: 100, automaticDutyEnd: false };
export type Session = { id: string; fmoId: string; startTime: string; expectedEndTime: string; actualEndTime: string | null; reportedStopTime: string | null; status: 'ACTIVE' | 'COMPLETED'; isDemo?: boolean; endLocationFailure?: string | null };
export type Attendance = { id: string; dutySessionId: string; checkInTime: string; accuracy: number; verificationStatus: string; supersededAt?: string | null };
export type StartInput = { requestId: string; location: Point; device: { installationId: string; model?: string; osVersion?: string; appVersion?: string } };
export type EndInput = { requestId: string; dutySessionId: string; finalLocation: Point | null; locationFailure?: 'GPS_UNAVAILABLE' | 'PERMISSION_REVOKED'; reportedStopTime?: string };
export type PhotoJob = { metadata: { requestId: string; dutySessionId: string; challengeToken: string; location: Point }; uri: string; blocked: boolean; error: string | null };
export type Phase = 'START_PENDING' | 'ACTIVE' | 'PAUSED' | 'STOPPING' | 'ENDING' | 'COMPLETED';
export type Duty = { key: string; ownerId: string; fmoId: string; phase: Phase; canCollect: boolean; session: Session | null; start: StartInput | null; end: EndInput | null;
  photo: PhotoJob | null; attendance: Attendance | null; settings: Settings; lastPoint: Point | null; stopRequestedAt: string | null; issue: string | null; consentVersion: string };
export type QueuedPoint = { id: string; ownerId: string; sessionId: string; point: Point; status: 'PENDING' | 'REJECTED'; reason: string | null };
export type Ack = { index: number; clientPointId: string | null; status: 'accepted' | 'duplicate' | 'rejected'; code?: string };
export type CurrentReply = { session: Session | null; attendance?: Attendance | null; settings: Settings; trackingAuthorized: boolean };
export type Sql = { exec(sql: string): Promise<void>; run(sql: string, ...params: (string | number | null)[]): Promise<void>; all<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]> };
export type SqlDatabase = Sql & { transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T> };
export interface Transport { json<T>(path: string, method?: string, body?: unknown): Promise<T>; selfie<T>(job: PhotoJob): Promise<T> }
export interface Platform { uuid(): string; now(): string; stopTracking(): Promise<void>; deletePhoto(uri: string): Promise<void> }
export class ApiFailure extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
  get retryable() { return this.status === 0 || this.status === 429 || this.status >= 500; }
}
