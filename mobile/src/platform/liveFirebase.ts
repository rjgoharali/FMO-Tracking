import { push, ref, set } from 'firebase/database';
import { ensureFirebaseIdentity, firebaseDatabase } from './firebase';

export type FirebaseLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
  speed?: number | null;
  batteryLevel?: number | null;
};

export async function publishLocation(sessionId: string, point: FirebaseLocation) {
  await ensureFirebaseIdentity();
  const pointRef = push(ref(firebaseDatabase, `locations/${sessionId}`));
  await set(pointRef, point);
  return pointRef.key;
}

export async function publishAttendance(sessionId: string, record: { fmoId: string; checkInTime: string; latitude: number; longitude: number; accuracy: number }) {
  await ensureFirebaseIdentity();
  await set(ref(firebaseDatabase, `attendance/${sessionId}`), record);
}
