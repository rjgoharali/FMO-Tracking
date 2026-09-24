import { ApiFailure, type Ack, type Attendance, type CurrentReply, type Duty, type Platform, type Session, type Transport, type User } from './types.ts';
import { Repository } from './repository.ts';
import { publishAttendance, publishDutySession, publishLocation } from '../platform/liveFirebase';

export class SyncEngine {
  repo: Repository; api: Transport; platform: Platform;
  constructor(repo: Repository, api: Transport, platform: Platform) { this.repo = repo; this.api = api; this.platform = platform; }
  async synchronize(user: User) {
    const holder = this.platform.uuid();
    if (!await this.repo.lease('sync', holder, Date.now(), 180000)) return;
    let contactedServer = false;
    try {
      let duty = await this.repo.current(user.id);
      if (!duty) return;
      if (duty.phase === 'STOPPING') {
        if (Date.now() - Date.parse(duty.stopRequestedAt!) < 90000) return;
        // Process died after local stop but before final-fix persistence: never restart GPS.
        await this.platform.stopTracking();
        duty = await this.repo.update(duty.key, d => ({ ...d, phase: 'ENDING', canCollect: false,
          end: { requestId: this.platform.uuid(), dutySessionId: d.session!.id, finalLocation: null, locationFailure: 'GPS_UNAVAILABLE', reportedStopTime: d.stopRequestedAt! } }));
      }
      if (duty.phase === 'START_PENDING') {
        const result = await this.api.json<{ session: Session }>('/api/duty/start', 'POST', duty.start);
        contactedServer = true;
        void publishDutySession(result.session.id, user.fmoId).catch(() => undefined);
        duty = await this.repo.update(duty.key, d => ({ ...d, session: result.session, phase: result.session.status === 'COMPLETED' ? 'COMPLETED' : 'PAUSED', canCollect: false,
          issue: result.session.status === 'ACTIVE' ? 'Duty confirmed. Tap Resume tracking if the service has not started.' : null }));
        // Foreground controller explicitly starts/resumes the native service.
      }
      if (duty.photo && !duty.photo.blocked) {
        try {
          let result: { attendance: Attendance };
          if (duty.phase === 'ENDING' || duty.phase === 'COMPLETED') {
            const remote = await this.api.json<CurrentReply>('/api/duty/current');
            if (remote.session?.id !== duty.session?.id || !remote.attendance) throw new ApiFailure(422, 'CHECK_IN_NOT_CONFIRMED', 'Check-in was not confirmed before duty ended. Contact your administrator.');
            result = { attendance: remote.attendance };
          } else result = await this.api.selfie<{ attendance: Attendance }>(duty.photo);
          contactedServer = true;
          const checkInPoint = duty.photo?.metadata.location;
          if (checkInPoint) void publishAttendance(result.attendance.dutySessionId, { fmoId: user.fmoId, checkInTime: result.attendance.checkInTime, latitude: checkInPoint.latitude, longitude: checkInPoint.longitude, accuracy: result.attendance.accuracy }).catch(() => undefined);
          const uri = duty.photo.uri;
          duty = await this.repo.update(duty.key, d => ({ ...d, attendance: result.attendance, photo: null, issue: null }));
          await this.platform.deletePhoto(uri);
        } catch (error) {
          if (!(error instanceof ApiFailure) || error.retryable || error.status === 401) throw error;
          duty = await this.repo.update(duty.key, d => ({ ...d, photo: d.photo ? { ...d.photo, blocked: true, error: error.message } : null, issue: `Check-in not confirmed: ${error.message}` }));
        }
      }
      // Process a bounded number of durable batches. More remain for the next task/tick.
      for (let batch = 0; batch < 3; batch++) {
        const first = (await this.repo.pending(user.id, undefined, 1))[0];
        if (!first) break;
        const sent = await this.repo.pending(user.id, first.sessionId, 100);
        const reply = await this.api.json<{ acknowledgments: Ack[]; dutyStatus: string; trackingIntervalSeconds: number }>('/api/duty/location', 'POST', { dutySessionId: first.sessionId, points: sent.map(p => p.point) });
        contactedServer = true;
        for (const point of sent) void publishLocation(first.sessionId, { latitude: point.point.latitude, longitude: point.point.longitude, accuracy: point.point.accuracy, recordedAt: point.point.recordedAt, speed: point.point.speed, batteryLevel: point.point.batteryLevel }).catch(() => undefined);
        await this.repo.acknowledge(user.id, first.sessionId, sent, reply.acknowledgments);
        if (first.sessionId === duty.session?.id) {
          duty = await this.repo.update(duty.key, d => ({ ...d,
            settings: { ...d.settings, trackingIntervalSeconds: Math.max(30, Math.min(300, reply.trackingIntervalSeconds || d.settings.trackingIntervalSeconds)) },
            ...(reply.dutyStatus === 'COMPLETED' ? { phase: d.phase === 'ACTIVE' ? 'PAUSED' : d.phase, canCollect: false } : {}) }));
          if (reply.dutyStatus === 'COMPLETED') await this.platform.stopTracking();
        }
      }
      duty = (await this.repo.get(duty.key))!;
      if (duty.phase === 'ENDING' && duty.end && (await this.repo.pending(user.id, duty.session!.id, 1)).length === 0) {
        const result = await this.api.json<{ session: Session }>('/api/duty/end', 'POST', duty.end);
        contactedServer = true;
        duty = await this.repo.update(duty.key, d => ({ ...d, phase: 'COMPLETED', canCollect: false, session: result.session, issue: null }));
        await this.platform.stopTracking();
      }
      if (contactedServer) await this.repo.setValue(`lastSync:${user.id}`, this.platform.now());
      await this.repo.setValue(`retry:${user.id}`, '0');
    } catch (error) {
      const current = await this.repo.current(user.id);
      if (current) {
        if (current.phase === 'START_PENDING' && error instanceof ApiFailure && error.code === 'DUTY_ALREADY_ACTIVE') {
          const remote = await this.api.json<CurrentReply>('/api/duty/current');
          if (remote.session) await this.repo.update(current.key, d => ({ ...d, phase: 'PAUSED', canCollect: false, session: remote.session, attendance: remote.attendance ?? null, settings: remote.settings, issue: 'Existing duty recovered. Tap Resume tracking.' }));
        }
        await this.repo.update(current.key, d => ({ ...d, issue: error instanceof Error ? error.message : 'Synchronization failed. Your records are retained.',
          ...(error instanceof ApiFailure && [400, 404, 422].includes(error.status) && d.phase === 'START_PENDING' ? { phase: 'COMPLETED', canCollect: false } : {}),
          ...(error instanceof ApiFailure && error.status === 401 && d.phase === 'ACTIVE' ? { phase: 'PAUSED', canCollect: false } : {}) }));
        if (error instanceof ApiFailure && error.status === 401) await this.platform.stopTracking();
      }
      throw error;
    } finally { await this.repo.release('sync', holder); }
  }
  async reconcile(user: User) {
    const result = await this.api.json<CurrentReply>('/api/duty/current');
    let local = await this.repo.current(user.id);
    if (local && ['STOPPING', 'ENDING', 'START_PENDING'].includes(local.phase)) return;
    if (result.session) {
      if (local?.session?.id === result.session.id) {
        // A durable local stop is never overridden by a stale ACTIVE server response.
        if (local.stopRequestedAt || local.phase === 'COMPLETED') return;
        await this.repo.update(local.key, d => d.stopRequestedAt || !['ACTIVE', 'PAUSED'].includes(d.phase) ? d : ({ ...d, session: result.session, attendance: result.attendance ?? null, settings: result.settings,
          ...(result.trackingAuthorized === false ? { phase: 'PAUSED', canCollect: false, issue: 'The server has not authorized tracking for this duty.' } : {}) }));
        if (result.trackingAuthorized === false) await this.platform.stopTracking();
      } else if (!local || local.phase === 'COMPLETED') {
        const recovery: Duty = { key: this.platform.uuid(), ownerId: user.id, fmoId: user.fmoId, phase: 'PAUSED', canCollect: false, session: result.session,
          start: null, end: null, photo: null, attendance: result.attendance ?? null, settings: result.settings, lastPoint: null, stopRequestedAt: null,
          issue: 'An active duty was found. Confirm permissions and tap Resume tracking on this phone.', consentVersion: '' };
        await this.repo.create(recovery);
      } else {
        await this.repo.update(local.key, d => ({ ...d, phase: 'PAUSED', canCollect: false, issue: 'Server duty differs from this device. Contact your administrator before resuming.' }));
        await this.platform.stopTracking();
      }
    } else if (local?.session && ['ACTIVE', 'PAUSED'].includes(local.phase)) {
      const details = await this.api.json<{ items: Session[] }>(`/api/fmos/${user.fmoId}/sessions?limit=100`);
      const remote = details.items.find(s => s.id === local!.session!.id);
      await this.repo.update(local.key, d => ({ ...d, canCollect: false, phase: remote?.status === 'COMPLETED' ? 'COMPLETED' : 'PAUSED', session: remote ?? d.session,
        issue: remote?.status === 'COMPLETED' ? null : 'Duty is no longer active on the server. Tracking has been paused.' }));
      await this.platform.stopTracking();
    }
  }
}
