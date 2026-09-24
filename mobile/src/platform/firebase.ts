import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';

const config = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL,
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(config);
export const firebaseAuth = getAuth(firebaseApp);
export const firebaseDatabase = getDatabase(firebaseApp);

export async function signInFmo(email: string, password: string) {
  return signInWithEmailAndPassword(firebaseAuth, email, password);
}

export async function signOutFmo() {
  return signOut(firebaseAuth);
}

/** Realtime Database writes use an anonymous Firebase identity. The business
 * login remains the server JWT login; this identity only protects live data. */
export async function ensureFirebaseIdentity(): Promise<User> {
  if (firebaseAuth.currentUser) return firebaseAuth.currentUser;
  return (await signInAnonymously(firebaseAuth)).user;
}
