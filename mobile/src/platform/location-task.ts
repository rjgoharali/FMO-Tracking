import * as TaskManager from 'expo-task-manager';
import type * as Location from 'expo-location';
import { repository } from './database';
import { LOCATION_TASK, asPoint, batteryPercent, stopTracking } from './tracking';
import { notify, pump } from './runtime';

// Imported by index.ts before React mounts; not defined inside a component/hook.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  try {
  const repo = await repository(); const owner = await repo.value('owner');
  if (!owner) { await stopTracking(); return; }
  const duty = await repo.current(owner);
  if (!duty || duty.phase !== 'ACTIVE' || !duty.canCollect || duty.stopRequestedAt) { await stopTracking(); return; }
  if (error) {
    await repo.update(duty.key, d => ({ ...d, canCollect: false, phase: d.phase === 'ACTIVE' ? 'PAUSED' : d.phase, issue: `Android location service: ${error.message}. Reopen the app to review permissions and resume.` }));
    await stopTracking(); notify(); return;
  }
  try {
    const battery = await batteryPercent();
    const points = (data?.locations ?? []).map(location => asPoint(location, battery)).filter(point => point !== null);
    // Transaction rechecks the collection gate; a concurrent End Duty wins over late callbacks.
    await repo.append(owner, points);
    if (!points.length) await repo.update(duty.key, d => ({ ...d, issue: 'GPS returned no usable observation. Check GPS and permissions.' }));
    notify();
    await pump().catch(() => undefined); // Network failure is reported/persisted by the sync engine; points remain in SQLite.
  } catch (failure) {
    // A local persistence failure must stop collection rather than pretend it was recorded.
    await repo.update(duty.key, d => ({ ...d, phase: d.phase === 'ACTIVE' ? 'PAUSED' : d.phase, canCollect: false,
      issue: failure instanceof Error ? failure.message : 'Unable to save GPS locally. Tracking paused.' })).catch(() => undefined);
    await stopTracking(); notify();
  }
  } catch (failure) {
    // Even an unreadable database cannot authorize ongoing collection.
    await stopTracking(); notify(); throw failure;
  }
});
