import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import { AppState } from 'react-native';
import { ApiClient } from '../core/client';
import { SyncEngine } from '../core/sync';
import { ApiFailure, type Duty, type EndInput, type PhotoJob, type Settings, type User } from '../core/types';
import { repository } from './database';
import { vault } from './vault';
import { deletePhoto } from './photos';
import { freshPoint, permissions, startTracking, stopTracking } from './tracking';

const listeners = new Set<() => void>();
export function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function notify() { for (const listener of listeners) listener(); }
let initialization: ReturnType<typeof createRuntime> | null = null;
async function createRuntime() {
  const repo = await repository();
  const baseUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? '';
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('Set EXPO_PUBLIC_API_URL in mobile/.env before building the app.');
  if (!__DEV__ && !baseUrl.startsWith('https://')) throw new Error('Release builds require an HTTPS API address.');
  const api = new ApiClient({ baseUrl, vault, repo, uuid: Crypto.randomUUID, photoBody: (job: PhotoJob) => {
    const form = new FormData(); form.append('metadata', JSON.stringify(job.metadata));
    form.append('selfie', { uri: job.uri, name: 'live-selfie.jpg', type: 'image/jpeg' } as unknown as Blob); return form;
  } });
  const platform = { uuid: Crypto.randomUUID, now: () => new Date().toISOString(), stopTracking, deletePhoto };
  return { repo, api, engine: new SyncEngine(repo, api, platform) };
}
export function runtime() { if (!initialization) initialization = createRuntime().catch(error => { initialization = null; throw error; }); return initialization; }
let inFlight: Promise<void> | null = null;
export async function pump(force = false) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const { repo, engine } = await runtime(); const credentials = await vault.read();
    if (!credentials) return;
    const retry = Number(await repo.value(`retryAt:${credentials.user.id}`) ?? 0);
    if (!force && retry > Date.now()) return;
    const network = await Network.getNetworkStateAsync();
    if (!network.isConnected) return;
    try {
      await engine.synchronize(credentials.user);
      await repo.setValue(`failures:${credentials.user.id}`, '0');
      await repo.setValue(`retryAt:${credentials.user.id}`, '0');
    } catch (error) {
      const failures = Math.min(6, Number(await repo.value(`failures:${credentials.user.id}`) ?? 0) + 1);
      await repo.setValue(`failures:${credentials.user.id}`, String(failures));
      await repo.setValue(`retryAt:${credentials.user.id}`, String(Date.now() + Math.min(300000, 5000 * 2 ** failures)));
      throw error;
    } finally { notify(); }
  })();
  try { return await inFlight; } finally { inFlight = null; }
}
export async function resume(user: User, requestPermissions: boolean) {
  if (AppState.currentState !== 'active') throw new Error('Open the app to resume the visible tracking service.');
  if ((await vault.read())?.needsLogin === 'revoked') throw new Error('Sign in again before resuming tracking.');
  const { repo } = await runtime(); const duty = await repo.current(user.id);
  if (!duty?.session || !['ACTIVE', 'PAUSED'].includes(duty.phase) || duty.stopRequestedAt) throw new Error('This duty cannot resume tracking.');
  await permissions(requestPermissions);
  await repo.update(duty.key, d => {
    if (!['ACTIVE', 'PAUSED'].includes(d.phase) || d.stopRequestedAt) throw new Error('This duty has already stopped.');
    return { ...d, phase: 'ACTIVE', canCollect: true, consentVersion: 'duty-location-v1', issue: null };
  });
  try {
    await startTracking(duty.settings.trackingIntervalSeconds);
    // End Duty can close the gate while Android is starting the service.
    const current = await repo.get(duty.key);
    if (!current?.canCollect || current.stopRequestedAt || current.phase !== 'ACTIVE') await stopTracking();
  }
  catch (error) {
    await repo.update(duty.key, d => d.phase === 'ACTIVE' ? { ...d, phase: 'PAUSED', canCollect: false, issue: 'Android could not start tracking. Open permissions and retry.' } : d);
    await stopTracking().catch(() => undefined); throw error;
  } finally { notify(); }
}
export async function startDuty(user: User) {
  const { repo, api } = await runtime();
  if (await repo.unfinished()) throw new Error('Resolve the existing duty before starting another.');
  if ((await repo.counts(user.id)).pending) throw new Error('Synchronize pending locations before starting another duty.');
  const { settings } = await api.json<{ settings: Settings }>('/api/settings');
  await permissions(true); const location = await freshPoint();
  if (location.mocked) throw new Error('Mock GPS cannot be used for duty attendance.');
  if (location.accuracy > settings.gpsAccuracyThresholdMeters) throw new Error(`GPS accuracy is ${Math.round(location.accuracy)}m. Move to an open area and retry.`);
  let installationId = await repo.value('installationId');
  if (!installationId) { installationId = Crypto.randomUUID(); await repo.setValue('installationId', installationId); }
  const key = Crypto.randomUUID();
  const duty: Duty = { key, ownerId: user.id, fmoId: user.fmoId, phase: 'START_PENDING', canCollect: false, session: null,
    start: { requestId: key, location, device: { installationId, appVersion: '0.3.0' } }, end: null, photo: null, attendance: null, settings,
    lastPoint: location, stopRequestedAt: null, issue: null, consentVersion: 'duty-location-v1' };
  await repo.create(duty); notify();
  await pump(true);
  const confirmed = await repo.current(user.id);
  if (confirmed?.phase === 'PAUSED' && confirmed.session?.status === 'ACTIVE') await resume(user, false);
}
export async function endDuty(user: User) {
  const { repo } = await runtime(); const duty = await repo.current(user.id);
  if (!duty?.session || !['ACTIVE', 'PAUSED'].includes(duty.phase)) throw new Error('There is no active duty to end.');
  const stopRequestedAt = new Date().toISOString();
  // Close the durable callback gate first. Failure here must not silently report completion.
  await repo.update(duty.key, d => ({ ...d, phase: 'STOPPING', canCollect: false, stopRequestedAt, issue: null })); notify();
  let stopError: string | null = null;
  try { await stopTracking(); } catch { stopError = 'Android service stop could not be confirmed. The local collection gate is closed; reopen the app to retry.'; }
  await inFlight?.catch(() => undefined);
  let finalLocation = null; let locationFailure: EndInput['locationFailure'];
  try { finalLocation = await freshPoint(); } catch { locationFailure = 'GPS_UNAVAILABLE'; }
  const end: EndInput = { requestId: Crypto.randomUUID(), dutySessionId: duty.session.id, finalLocation,
    ...(locationFailure ? { locationFailure } : {}), reportedStopTime: new Date().toISOString() };
  await repo.update(duty.key, d => d.phase === 'STOPPING' ? { ...d, phase: 'ENDING', end, issue: stopError } : d);
  notify(); await pump(true);
}
export async function recoverForeground() {
  const { repo, engine } = await runtime(); const credentials = await vault.read(); if (!credentials) return;
  let duty = await repo.current(credentials.user.id);
  if (duty && !duty.canCollect) await stopTracking().catch(() => undefined);
  if (credentials.needsLogin === 'revoked') {
    if (duty?.phase === 'ACTIVE') await repo.update(duty.key, d => ({ ...d, phase: 'PAUSED', canCollect: false, issue: 'Sign in again to resume duty tracking.' }));
    await stopTracking().catch(() => undefined); notify(); return;
  }
  try { await pump(); await engine.reconcile(credentials.user); }
  catch (error) {
    if (error instanceof ApiFailure && error.status === 401) {
      if (duty) await repo.update(duty.key, d => d.phase === 'ACTIVE' ? { ...d, phase: 'PAUSED', canCollect: false, issue: 'Sign in again to resume duty tracking.' } : d);
      await stopTracking().catch(() => undefined); notify(); return;
    }
  }
  duty = await repo.current(credentials.user.id);
  if (duty?.phase === 'ACTIVE' && duty.canCollect) {
    try { await resume(credentials.user, false); }
    catch (error) {
      await repo.update(duty.key, d => d.phase === 'ACTIVE' ? { ...d, phase: 'PAUSED', canCollect: false, issue: error instanceof Error ? error.message : 'Check Android location permissions.' } : d);
      await stopTracking().catch(() => undefined);
    }
  }
  notify();
}
