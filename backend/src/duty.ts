import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { startDutySchema, endDutySchema, challengeSchema, checkInSchema, batchEnvelopeSchema } from '../../packages/contracts/src/api.js';
import { Auth, digest, fingerprint } from './auth.js';
import { one, serverTime, audit, type Database, type Db } from './db.js';
import { fail } from './errors.js';
import type { DutyRow, Principal } from './types.js';
import { getSettings } from './settings.js';
import { ingestPoint, requireFreshGps } from './locations.js';
import { publicAttendance, publicDuty, publicLocation } from './presenters.js';
import { sanitizeSelfie, type PrivateStorage, type SelfieVerifier } from './storage.js';

export async function ownedSession(tx: Db, actor: Principal, id: string) {
  const session = await one<DutyRow>(tx, 'SELECT * FROM duty_sessions WHERE id=$1 AND fmo_id=$2 FOR UPDATE', [id, actor.fmoId]);
  if (!session) fail(404, 'DUTY_NOT_FOUND', 'Duty session not found');
  return session;
}
async function readMultipart(request: FastifyRequest) {
  let metadata: unknown; let file: Buffer | undefined; let mime = '';
  if (!request.isMultipart()) fail(415, 'MULTIPART_REQUIRED', 'Submit metadata and a live selfie as multipart/form-data');
  for await (const part of request.parts({ limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2, fieldSize: 16384 } })) {
    if (part.type === 'file') {
      if (part.fieldname !== 'selfie' || file) fail(400, 'INVALID_UPLOAD', 'Exactly one selfie file is required');
      mime = part.mimetype; file = await part.toBuffer();
      if (part.file.truncated) fail(413, 'IMAGE_SIZE', 'Selfie must be no larger than 5 MB');
    } else {
      if (part.fieldname !== 'metadata' || metadata !== undefined || part.valueTruncated || typeof part.value !== 'string') fail(400, 'INVALID_METADATA', 'One metadata JSON field is required');
      try { metadata = JSON.parse(part.value); } catch { fail(400, 'INVALID_METADATA', 'Metadata must contain valid JSON'); }
    }
  }
  if (!file || !metadata) fail(400, 'INCOMPLETE_CHECK_IN', 'Selfie and check-in metadata are required');
  return { metadata: checkInSchema.parse(metadata), file, mime };
}
export async function registerDuty(app: FastifyInstance, db: Database, auth: Auth, storage: PrivateStorage, verifier: SelfieVerifier) {
  const fmo = auth.roles('FMO');
  app.get('/api/duty/current', { preHandler: fmo }, async request => {
    const session = await one<DutyRow>(db, "SELECT * FROM duty_sessions WHERE fmo_id=$1 AND status='ACTIVE'", [request.principal!.fmoId]);
    const settings = await getSettings(db);
    if (!session) return { session: null, settings, trackingAuthorized: false };
    const attendance = await one(db, 'SELECT * FROM attendance WHERE duty_session_id=$1 AND superseded_at IS NULL', [session.id]);
    const location = await one(db, 'SELECT * FROM location_logs WHERE duty_session_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1', [session.id]);
    return { session: publicDuty(session), attendance: attendance ? publicAttendance(attendance) : null, lastLocation: location ? publicLocation(location) : null,
      settings, trackingAuthorized: true, serverTime: await serverTime(db) };
  });
  app.post('/api/duty/start', { preHandler: fmo }, async (request, reply) => {
    const input = startDutySchema.parse(request.body); const actor = request.principal!; const hash = fingerprint(input);
    const result = await db.transaction(async tx => {
      await auth.lockActor(tx, actor);
      // Serialize simultaneous starts even when no active session exists yet.
      await tx.query('SELECT id FROM fmos WHERE id=$1 FOR UPDATE', [actor.fmoId]);
      const previous = await one<DutyRow>(tx, 'SELECT * FROM duty_sessions WHERE fmo_id=$1 AND start_request_id=$2', [actor.fmoId, input.requestId]);
      if (previous) {
        if (previous.start_request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'Request ID was already used with different data');
        return { session: publicDuty(previous), replayed: true, trackingAuthorized: previous.status === 'ACTIVE' };
      }
      if (await one(tx, "SELECT id FROM duty_sessions WHERE fmo_id=$1 AND status='ACTIVE'", [actor.fmoId])) fail(409, 'DUTY_ALREADY_ACTIVE', 'End your current duty before starting another');
      const settings = await getSettings(tx); const now = await serverTime(tx);
      requireFreshGps(input.location, settings, now);
      const device = await one<{ id: string; revoked_at: Date | null }>(tx, `INSERT INTO devices(fmo_id,installation_id,model,os_version,app_version,last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(fmo_id,installation_id) DO UPDATE SET model=EXCLUDED.model,os_version=EXCLUDED.os_version,
        app_version=EXCLUDED.app_version,last_seen_at=EXCLUDED.last_seen_at RETURNING id,revoked_at`,
        [actor.fmoId, input.device.installationId, input.device.model ?? null, input.device.osVersion ?? null, input.device.appVersion ?? null, now]);
      if (device!.revoked_at) fail(403, 'DEVICE_REVOKED', 'This device registration has been revoked');
      const session = await one<DutyRow>(tx, `INSERT INTO duty_sessions(fmo_id,device_id,start_request_id,start_request_hash,start_time,expected_end_time,
        duty_duration_minutes,tracking_interval_seconds) VALUES ($1,$2,$3,$4,$5,$5::timestamptz+$6*interval '1 minute',$6,$7) RETURNING *`,
        [actor.fmoId, device!.id, input.requestId, hash, now, settings.dutyDurationMinutes, settings.trackingIntervalSeconds]);
      const ack = await ingestPoint(tx, session!, input.location, 0, settings, now);
      if (ack.status === 'rejected') fail(422, ack.code!, 'Initial location was rejected');
      await audit(tx, actor.userId, 'DUTY_STARTED', 'DUTY_SESSION', session!.id);
      return { session: publicDuty(session!), replayed: false, trackingAuthorized: true };
    });
    reply.code(result.replayed ? 200 : 201); return result;
  });
  app.post('/api/duty/check-in/challenge', { preHandler: fmo, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const input = challengeSchema.parse(request.body); const actor = request.principal!;
    return db.transaction(async tx => {
      await auth.lockActor(tx, actor); const session = await ownedSession(tx, actor, input.dutySessionId);
      if (session.status !== 'ACTIVE') fail(409, 'DUTY_COMPLETED', 'Duty has already ended');
      if (await one(tx, 'SELECT id FROM attendance WHERE duty_session_id=$1 AND superseded_at IS NULL', [session.id])) fail(409, 'ALREADY_CHECKED_IN', 'Attendance is already recorded');
      await tx.query('UPDATE camera_challenges SET consumed_at=clock_timestamp() WHERE duty_session_id=$1 AND consumed_at IS NULL', [session.id]);
      const token = randomBytes(48).toString('base64url');
      const row = await one(tx, `INSERT INTO camera_challenges(duty_session_id,fmo_id,token_hash,expires_at)
        VALUES ($1,$2,$3,clock_timestamp()+interval '2 minutes') RETURNING expires_at`, [session.id, actor.fmoId, digest(token)]);
      return { challengeToken: token, expiresAt: row!.expires_at, instruction: 'Open the front camera and capture a new selfie now. Gallery images are not permitted.' };
    });
  });
  app.post('/api/duty/check-in', { preHandler: fmo, bodyLimit: 6 * 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { metadata: input, file, mime } = await readMultipart(request); const actor = request.principal!;
    const requestHash = fingerprint({ ...input, fileHash: digest(file) });
    const image = await sanitizeSelfie(file, mime);
    const result = await db.transaction(async tx => {
      await auth.lockActor(tx, actor); const session = await ownedSession(tx, actor, input.dutySessionId);
      const previous = await one(tx, 'SELECT * FROM attendance WHERE check_in_request_id=$1', [input.requestId]);
      if (previous) {
        if (previous.fmo_id !== actor.fmoId || previous.duty_session_id !== session.id || previous.request_hash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', 'Check-in request ID was already used');
        if (previous.superseded_at) fail(409, 'CHECK_IN_RESET', 'Admin reset this attendance. Capture a new selfie with a new challenge');
        return { attendance: publicAttendance(previous), replayed: true };
      }
      if (session.status !== 'ACTIVE') fail(409, 'DUTY_COMPLETED', 'Duty has already ended');
      if (await one(tx, 'SELECT id FROM attendance WHERE duty_session_id=$1 AND superseded_at IS NULL', [session.id])) fail(409, 'ALREADY_CHECKED_IN', 'Attendance is already recorded');
      const challenge = await one<{ id: string; created_at: Date; valid: boolean }>(tx, `SELECT *,consumed_at IS NULL AND expires_at>clock_timestamp() AS valid
        FROM camera_challenges WHERE token_hash=$1 AND duty_session_id=$2 AND fmo_id=$3 FOR UPDATE`, [digest(input.challengeToken), session.id, actor.fmoId]);
      if (!challenge?.valid) fail(422, 'CHALLENGE_EXPIRED', 'Open the camera again to request a fresh check-in challenge');
      const settings = await getSettings(tx); const now = await serverTime(tx);
      requireFreshGps(input.location, settings, now);
      if (Date.parse(input.location.recordedAt) < new Date(challenge.created_at).getTime() - 120000) fail(422, 'STALE_GPS', 'Capture a new location for this check-in');
      if (await one(tx, 'SELECT id FROM attendance WHERE fmo_id=$1 AND selfie_sha256=$2 AND NOT is_demo', [actor.fmoId, image.hash])) fail(409, 'SELFIE_REUSED', 'Capture a new selfie; this image was already submitted');
      const verification = await verifier.verify(image.image);
      if (verification.status === 'REJECTED') fail(422, 'VERIFICATION_REJECTED', 'Selfie verification failed. Capture a new image');
      const key = `selfies/${randomUUID()}.jpg`;
      try { await storage.put(key, image.image, 'image/jpeg'); }
      catch { fail(503, 'SELFIE_STORAGE_UNAVAILABLE', 'Unable to save selfie. Retry this check-in when the server is available'); }
      const attendance = await one(tx, `INSERT INTO attendance(duty_session_id,fmo_id,check_in_request_id,request_hash,check_in_time,selfie_storage_key,
        selfie_sha256,selfie_mime_type,latitude,longitude,accuracy,verification_status,device_recorded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'image/jpeg',$8,$9,$10,$11,$12) RETURNING *`,
        [session.id, actor.fmoId, input.requestId, requestHash, now, key, image.hash, input.location.latitude, input.location.longitude,
          input.location.accuracy, verification.status, new Date(input.location.recordedAt)]);
      await tx.query('UPDATE camera_challenges SET consumed_at=clock_timestamp() WHERE id=$1', [challenge.id]);
      const ack = await ingestPoint(tx, session, input.location, 0, settings, now);
      if (ack.status === 'rejected') fail(422, ack.code!, 'Check-in location was rejected');
      await audit(tx, actor.userId, 'CHECKED_IN', 'ATTENDANCE', String(attendance!.id));
      return { attendance: publicAttendance(attendance!), replayed: false };
    });
    reply.code(result.replayed ? 200 : 201); return result;
  });
  app.post('/api/duty/location', { preHandler: fmo }, async request => {
    const input = batchEnvelopeSchema.parse(request.body); const actor = request.principal!;
    return db.transaction(async tx => {
      await auth.lockActor(tx, actor); const session = await ownedSession(tx, actor, input.dutySessionId);
      const settings = await getSettings(tx); const now = await serverTime(tx); const acknowledgments = [];
      for (let i = 0; i < input.points.length; i++) acknowledgments.push(await ingestPoint(tx, session, input.points[i], i, settings, now));
      if (session.device_id) await tx.query('UPDATE devices SET last_seen_at=$2 WHERE id=$1', [session.device_id, now]);
      return { acknowledgments, serverTime: now, dutyStatus: session.status, trackingIntervalSeconds: settings.trackingIntervalSeconds };
    });
  });
  app.post('/api/duty/end', { preHandler: fmo }, async request => {
    const input = endDutySchema.parse(request.body); const actor = request.principal!; const hash = fingerprint(input);
    return db.transaction(async tx => {
      await auth.lockActor(tx, actor); const session = await ownedSession(tx, actor, input.dutySessionId);
      if (session.status === 'COMPLETED') {
        if (session.end_request_id !== input.requestId || session.end_request_hash !== hash) fail(409, 'DUTY_COMPLETED', 'Duty is complete; retry the original end request only');
        return { session: publicDuty(session), replayed: true, trackingAuthorized: false };
      }
      const now = await serverTime(tx); const settings = await getSettings(tx);
      const stop = input.reportedStopTime ? new Date(input.reportedStopTime) : now;
      if (stop > now || stop < new Date(session.start_time)) fail(422, 'INVALID_STOP_TIME', 'Reported stop time must be within this duty and not in the future');
      if (input.finalLocation && Math.abs(stop.getTime() - Date.parse(input.finalLocation.recordedAt)) > 120000) fail(422, 'STALE_FINAL_LOCATION', 'Final location must be captured near the reported duty stop');
      const ack = input.finalLocation ? await ingestPoint(tx, { ...session, actual_end_time: now, reported_stop_time: stop }, input.finalLocation, 0, settings, now) : null;
      if (ack?.status === 'rejected') fail(422, ack.code!, 'Final location was rejected. Pending records have not been deleted');
      const later = await one(tx, `SELECT 1 FROM location_logs WHERE duty_session_id=$1 AND recorded_at>$2
        UNION ALL SELECT 1 FROM attendance WHERE duty_session_id=$1 AND check_in_time>$2 LIMIT 1`, [session.id, stop]);
      if (later) fail(409, 'STOP_BEFORE_ACTIVITY', 'Reported stop precedes recorded activity. Reconcile the device clock and pending end request');
      const completed = await one<DutyRow>(tx, `UPDATE duty_sessions SET status='COMPLETED',actual_end_time=$2,reported_stop_time=$3,
        end_request_id=$4,end_request_hash=$5,end_location_failure=$6 WHERE id=$1 RETURNING *`, [session.id, now, input.reportedStopTime ? stop : null, input.requestId, hash, input.locationFailure ?? null]);
      await tx.query('UPDATE camera_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE duty_session_id=$1', [session.id]);
      await audit(tx, actor.userId, 'DUTY_ENDED', 'DUTY_SESSION', session.id, { reportedOfflineStop: Boolean(input.reportedStopTime), endLocationFailure: input.locationFailure ?? null });
      return { session: publicDuty(completed!), finalLocation: ack, replayed: false, trackingAuthorized: false };
    });
  });
}
