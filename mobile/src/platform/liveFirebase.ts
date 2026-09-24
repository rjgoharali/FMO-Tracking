import { push, ref, set } from 'firebase/database';
import { firebaseDatabase } from './firebase';

export type FirebaseLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
  speed?: number | null;
  batteryLevel?: number | null;
};

export async function publishLocation(sessionId: string, point: FirebaseLocation) {
  const pointRef = push(ref(firebaseDatabase, `locations/${sessionId}`));
  await set(pointRef, point);
  return pointRef.key;
}
