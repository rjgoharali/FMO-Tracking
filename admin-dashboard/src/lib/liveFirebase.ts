import { onValue, ref, query, orderByChild, limitToLast, type DataSnapshot } from 'firebase/database';
import { firebaseDatabase } from './firebase';

export type FirebaseLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
  speed?: number | null;
  batteryLevel?: number | null;
};

export function subscribeToSessionLocations(sessionId: string, onPoints: (points: FirebaseLocation[]) => void) {
  const locations = query(ref(firebaseDatabase, `locations/${sessionId}`), orderByChild('recordedAt'), limitToLast(2000));
  return onValue(locations, (snapshot: DataSnapshot) => {
    const value = snapshot.val() as Record<string, FirebaseLocation> | null;
    onPoints(value ? Object.values(value).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)) : []);
  });
}
