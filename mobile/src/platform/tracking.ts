import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as Crypto from 'expo-crypto';
import { PermissionsAndroid, Platform } from 'react-native';
import type { Point } from '../core/types';
export const LOCATION_TASK = 'fmo-duty-location-v1';
export async function permissions(request: boolean) {
  let foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted && request) foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error('Location permission denied. Enable location permission to start or resume duty.');
  if (foreground.android?.accuracy === 'coarse') throw new Error('Precise location is required. Enable precise location in Android settings.');
  let background = await Location.getBackgroundPermissionsAsync();
  if (!background.granted && request) background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) throw new Error('Allow location “all the time” in Android settings for duty tracking while the phone is locked.');
  if (!await Location.hasServicesEnabledAsync()) throw new Error('GPS is unavailable. Enable location services.');
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    let granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (!granted && request) granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS) === PermissionsAndroid.RESULTS.GRANTED;
    if (!granted) throw new Error('Allow notifications so the visible duty-tracking notification can be shown.');
  }
}
export async function batteryPercent() {
  try { const value = await Battery.getBatteryLevelAsync(); return value < 0 ? null : Math.round(value * 100); } catch { return null; }
}
export function asPoint(location: Location.LocationObject, battery: number | null): Point | null {
  const c = location.coords;
  if (![c.latitude, c.longitude, c.accuracy, location.timestamp].every(v => typeof v === 'number' && Number.isFinite(v)) || c.accuracy! < 0) return null;
  return { clientPointId: Crypto.randomUUID(), latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy!, recordedAt: new Date(location.timestamp).toISOString(),
    speed: c.speed !== null && c.speed >= 0 ? c.speed : null, batteryLevel: battery, mocked: location.mocked ?? false };
}
export async function freshPoint(): Promise<Point> {
  const battery = await batteryPercent();
  return new Promise((resolve, reject) => {
    let subscription: Location.LocationSubscription | null = null; let done = false;
    const finish = (point: Point | null, error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); subscription?.remove();
      if (point) resolve(point); else reject(error ?? new Error('GPS did not produce a usable reading. Move outdoors and retry.'));
    };
    const timer = setTimeout(() => finish(null), 20000);
    Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 }, location => {
      if (Date.now() - location.timestamp > 30000) return;
      const point = asPoint(location, battery); if (point) finish(point);
    }, reason => finish(null, new Error(`GPS is unavailable: ${reason}`))).then(value => { subscription = value; if (done) value.remove(); }).catch(error => finish(null, error instanceof Error ? error : new Error('Unable to request GPS.')));
  });
}
export async function stopTracking() { if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK); }
export async function startTracking(interval: number) {
  await permissions(false);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, { accuracy: Location.Accuracy.High, timeInterval: Math.max(30, interval) * 1000, distanceInterval: 0,
    deferredUpdatesInterval: Math.max(30, interval) * 1000,
    foregroundService: { notificationTitle: 'FMO Field Tracking Active', notificationBody: 'Your duty location is currently being recorded.', notificationColor: '#0D766E', killServiceOnDestroy: false } });
}
