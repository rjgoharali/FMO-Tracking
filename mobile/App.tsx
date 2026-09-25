import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View, Modal } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as Location from 'expo-location';
import type { Duty, PhotoJob, User } from './src/core/types';
import { runtime, subscribe, recoverForeground, pump, startDuty, endDuty, resume } from './src/platform/runtime';
import { vault } from './src/platform/vault';
import { freshPoint, LOCATION_TASK } from './src/platform/tracking';
import { retainPhoto, deletePhoto } from './src/platform/photos';

type Snapshot = { user: User | null; duty: Duty | null; pending: number; rejected: number; service: boolean; connected: boolean; seen: string | null; loginRequired: boolean };
const empty: Snapshot = { user: null, duty: null, pending: 0, rejected: 0, service: false, connected: false, seen: null, loginRequired: false };
const time = (value?: string | null) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
function Button({ title, onPress, disabled = false, secondary = false }: { title: string; onPress(): void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.secondary, disabled && { opacity: 0.45 }]}><Text style={[styles.buttonText, secondary && { color: '#102B39' }]}>{title}</Text></Pressable>;
}
function Field({ label, value }: { label: string; value: string }) { return <View style={styles.field}><Text style={styles.label}>{label}</Text><Text style={styles.value}>{value}</Text></View>; }
export default function App() { return <SafeAreaProvider><StatusBar style="dark" /><Mobile /></SafeAreaProvider>; }
function Mobile() {
  const [snapshot, setSnapshot] = useState(empty), [fatal, setFatal] = useState(''), [busy, setBusy] = useState(false);
  const [employee, setEmployee] = useState(''), [password, setPassword] = useState(''), [login, setLogin] = useState(false), [profile, setProfile] = useState(false);
  const [clock, setClock] = useState(Date.now()), [challenge, setChallenge] = useState<{ challengeToken: string; expiresAt: string } | null>(null), [ready, setReady] = useState(false);
  const camera = useRef<CameraView>(null), busyRef = useRef(false);
  const [, askCamera] = useCameraPermissions();
  async function refresh() {
    const { repo } = await runtime(); const credentials = await vault.read(); const cached = await repo.value('profile');
    const user: User | null = credentials?.user ?? (cached ? JSON.parse(cached) : null);
    const counts = user ? await repo.counts(user.id) : { pending: 0, rejected: 0 };
    setSnapshot({ user, duty: user ? await repo.current(user.id) : null, ...counts,
      service: await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK), connected: !!(await Network.getNetworkStateAsync()).isConnected,
      seen: await repo.value('serverSeen'), loginRequired: !!user && (!credentials || !!credentials.needsLogin || credentials.refreshing) });
    setFatal('');
  }
  async function act(action: () => Promise<unknown>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true);
    try { await action(); } catch (error) { Alert.alert('Action needs attention', error instanceof Error ? error.message : 'Please try again.'); }
    finally { busyRef.current = false; setBusy(false); await refresh().catch(error => setFatal(String(error))); }
  }
  useEffect(() => {
    const update = () => { void refresh().catch(error => setFatal(String(error))); };
    const recover = () => { void recoverForeground().catch(error => setFatal(String(error))).finally(update); };
    update(); recover(); const unsubscribe = subscribe(update);
    const state = AppState.addEventListener('change', next => { if (next === 'active') recover(); else setChallenge(null); });
    const network = Network.addNetworkStateListener(next => { update(); if (next.isConnected) void pump().catch(update); });
    const tick = setInterval(() => setClock(Date.now()), 1000);
    const sync = setInterval(() => { if (AppState.currentState === 'active') void pump().catch(update); }, 15000);
    const recovery = setInterval(() => { if (AppState.currentState === 'active') recover(); }, 60000);
    return () => { unsubscribe(); state.remove(); network.remove(); clearInterval(tick); clearInterval(sync); clearInterval(recovery); };
  }, []);
  const { user, duty } = snapshot;
  function consent(action: () => Promise<unknown>) {
    Alert.alert('Location during duty', 'Starting or resuming duty records your location while this app is open, minimized or the phone is locked. Android displays a tracking notification. Your organization can review duty locations and attendance selfies. End Duty stops collection; pending records remain on this phone until synchronized. Camera capture is not biometric verification.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Continue', onPress: () => void act(action) }]);
  }
  async function checkIn() {
    if (!duty?.session || duty.phase !== 'ACTIVE') throw new Error('Start duty and resume tracking before checking in.');
    const location = await freshPoint();
    if (location.mocked || location.accuracy > duty.settings.gpsAccuracyThresholdMeters) throw new Error('GPS quality is insufficient for check-in. Move to an open area and retry.');
    const { api } = await runtime(); await api.json('/api/duty/check-in', 'POST', { dutySessionId: duty.session.id, challengeToken: Crypto.randomUUID(), location }); await pump(true);
  }
  async function capture() {
    if (!camera.current || !challenge || !duty?.session || !user || !ready) return;
    const { api, repo } = await runtime(); let uri: string | null = null;
    try {
      const token = Date.parse(challenge.expiresAt) < Date.now() + 10000 ? await api.json<{ challengeToken: string; expiresAt: string }>('/api/duty/check-in/challenge', 'POST', { dutySessionId: duty.session.id }) : challenge;
      const picture = await camera.current.takePictureAsync({ quality: 0.8 });
      if (!picture) throw new Error('Camera did not return a photo. Please try again.');
      uri = picture.uri; const location = await freshPoint();
      if (AppState.currentState !== 'active') throw new Error('Return to the app and take a new selfie.');
      if (location.mocked || location.accuracy > duty.settings.gpsAccuracyThresholdMeters) throw new Error('GPS quality is insufficient for check-in. Move to an open area and retry.');
      uri = await retainPhoto(uri);
      const photo: PhotoJob = { uri, metadata: { requestId: Crypto.randomUUID(), dutySessionId: duty.session.id, challengeToken: token.challengeToken, location }, blocked: false, error: null };
      const old = duty.photo?.uri;
      await repo.update(duty.key, current => { if (current.phase !== 'ACTIVE' || current.attendance) throw new Error('This duty is no longer eligible for check-in.'); return { ...current, photo, issue: null }; });
      uri = null; setChallenge(null); if (old) await deletePhoto(old); await pump(true);
    } finally { if (uri) await deletePhoto(uri); }
  }
  if (fatal) return <SafeAreaView style={styles.root}><View style={styles.content}><Text style={styles.title}>App needs attention</Text><Text>{fatal}</Text><Button title="Retry" onPress={() => void act(recoverForeground)} /><Button secondary title="Android app settings" onPress={() => void Linking.openSettings()} /></View></SafeAreaView>;
  if (!user || login) return <SafeAreaView style={styles.root}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><View style={styles.hero}><Text style={styles.eyebrow}>FIELD OPERATIONS</Text><Text style={styles.heroTitle}>Ready for today’s duty.</Text><Text style={styles.heroText}>Secure attendance and visible duty tracking.</Text></View><Text style={styles.title}>FMO sign in</Text><Text style={styles.label}>FMO name or ID</Text><TextInput accessibilityLabel="FMO name or ID" autoCapitalize="words" autoCorrect={false} value={employee} onChangeText={setEmployee} style={styles.input} placeholder="Muhammad Kaleem Arif" /><Text style={styles.label}>Password</Text><TextInput accessibilityLabel="Password" secureTextEntry value={password} onChangeText={setPassword} style={styles.input} /><Button disabled={busy || !employee.trim() || !password} title={busy ? 'Signing in…' : 'Sign in'} onPress={() => void act(async () => { const { api } = await runtime(); await api.login(employee.trim(), password); setPassword(''); setLogin(false); await recoverForeground(); })} /><Text style={styles.note}>Administrators monitor field teams from the laptop dashboard. This application is for FMO duty only.</Text>{user && <Button secondary title="Back to duty" onPress={() => setLogin(false)} />}</ScrollView></SafeAreaView>;
  const active = duty?.phase === 'ACTIVE', completed = duty?.phase === 'COMPLETED' && !!duty.session;
  const recent = !!duty?.lastPoint && clock - Date.parse(duty.lastPoint.recordedAt) < duty.settings.staleAfterSeconds * 1000;
  const tracking = active && duty.canCollect && snapshot.service && recent;
  const elapsed = duty?.session ? Math.max(0, (Date.parse(duty.session.actualEndTime ?? duty.end?.reportedStopTime ?? duty.stopRequestedAt ?? '') || clock) - Date.parse(duty.session.startTime)) : 0;
  const status = completed ? 'COMPLETED' : active ? (duty.attendance ? 'CHECKED IN' : 'ON DUTY') : duty?.phase === 'ENDING' || duty?.phase === 'STOPPING' ? 'END PENDING SYNC' : duty?.phase === 'PAUSED' ? 'TRACKING PAUSED' : duty?.phase === 'START_PENDING' ? 'START PENDING' : 'NOT STARTED';
  return <SafeAreaView style={styles.root}><View style={styles.header}><Text style={styles.brand}>FMO / FIELD</Text><Pressable onPress={() => setProfile(!profile)}><Text style={styles.link}>{profile ? 'Duty overview' : 'My profile'}</Text></Pressable></View><ScrollView contentContainerStyle={styles.content}>
    <Text style={styles.label}>{duty?.settings.organizationName ?? 'Field Operations'}{user.isDemo ? ' • DEMO ACCOUNT' : ''}</Text><Text style={styles.title}>{profile ? 'My profile' : user.name}</Text><Text style={styles.note}>{user.employeeCode}</Text>
    {snapshot.loginRequired && <View style={styles.warning}><Text>Sign in again to synchronize. Saved locations remain on this phone. End Duty is still available.</Text><Button title="Sign in again" onPress={() => setLogin(true)} /></View>}
    {profile ? <View style={styles.card}><Field label="Name" value={user.name} /><Field label="Employee ID" value={user.employeeCode} /><Field label="Target update interval" value={String(duty?.settings.trackingIntervalSeconds ?? 45) + ' seconds'} /><Text style={styles.note}>Location is collected only during an authorized duty. Android restrictions can interrupt background tracking. Keep location and notification permissions enabled. Selfies are private attendance evidence, not biometric identity verification.</Text><Button secondary title="Android app permissions" onPress={() => void Linking.openSettings()} /><Button secondary disabled={busy} title="Sign out" onPress={() => void act(async () => { const { api } = await runtime(); await api.logout(); })} /></View> : <>
      <View style={styles.hero}><Text style={styles.eyebrow}>{status}</Text><Text style={styles.heroTitle}>{Math.floor(elapsed / 3600000)}h {Math.floor(elapsed / 60000) % 60}m</Text><Text style={styles.heroText}>Duty duration{duty?.phase === 'ENDING' ? ' • local stop, server confirmation pending' : ''}</Text><View style={styles.row}><Field label="STARTED" value={time(duty?.session?.startTime)} /><Field label="EXPECTED END" value={time(duty?.session?.expectedEndTime)} /></View></View>
      <View style={styles.card}><Text style={styles.section}>Today’s attendance</Text><Field label="1 / Start duty" value={duty?.session ? time(duty.session.startTime) : 'Not started'} /><Field label="2 / Live selfie check-in" value={duty?.attendance ? time(duty.attendance.checkInTime) + ' • Confirmed' : duty?.photo && !duty.photo.blocked ? 'Saved • confirmation pending' : 'Not checked in'} /><Field label="3 / End duty" value={time(duty?.session?.actualEndTime)} />
        {(!duty || duty.phase === 'COMPLETED') && <Button disabled={busy} title="Start duty" onPress={() => consent(() => startDuty(user))} />}
        {duty?.phase === 'PAUSED' && <Button disabled={busy} title="Resume tracking" onPress={() => consent(() => resume(user, true))} />}
        {active && !duty.attendance && <Button disabled={busy} title="Check in" onPress={() => void act(checkIn)} />}
        {(active || duty?.phase === 'PAUSED') && <Button secondary disabled={busy} title="End duty" onPress={() => Alert.alert('End this duty?', 'Location collection will stop. Pending records will synchronize when the server is available.', [{ text: 'Cancel', style: 'cancel' }, { text: 'End duty', onPress: () => void act(() => endDuty(user)) }])} />}
        {completed && !duty.attendance && <Text style={styles.note}>Duty completed without a confirmed check-in. Contact your administrator.</Text>}
      </View>
      <View style={styles.card}><Text style={styles.section}>Location & connection</Text><Field label="Tracking" value={tracking ? 'ACTIVE • recent GPS received' : active && snapshot.service ? 'Waiting for a recent GPS fix' : 'Not collecting'} /><Field label="Last location" value={duty?.lastPoint ? time(duty.lastPoint.recordedAt) + ' • ' + Math.max(0, Math.floor((clock - Date.parse(duty.lastPoint.recordedAt)) / 1000)) + 's ago' : 'No location yet'} /><Field label="GPS accuracy" value={duty?.lastPoint ? Math.round(duty.lastPoint.accuracy) + 'm' + (duty.lastPoint.accuracy > duty.settings.gpsAccuracyThresholdMeters ? ' • Poor' : ' • Acceptable') : '—'} /><Field label="Network" value={snapshot.connected ? 'Connected • server reachability separate' : 'Offline • records saved locally'} /><Field label="Last server response" value={time(snapshot.seen)} /><Field label="Saved locations awaiting sync" value={String(snapshot.pending)} />
        <Button secondary disabled={busy} title={busy ? 'Working…' : 'Synchronize now'} onPress={() => void act(() => pump(true))} />
        {snapshot.rejected > 0 && <Button secondary title={snapshot.rejected + ' records need review'} onPress={() => void act(async () => { const rows = await (await runtime()).repo.rejected(user.id); Alert.alert('Retained rejected records', rows.map(r => r.id + ': ' + r.reason).join('; ')); })} />}
      </View>
      {(duty?.issue || duty?.photo?.error) && <View style={styles.warning}><Text>{duty.issue ?? duty.photo?.error}</Text></View>}
      <Text style={styles.note}>Tracking is visible and limited to duty. Expected end is a reminder: press End Duty to stop. Android force-stop, reboot and battery restrictions may interrupt collection; reopen this app to review its status.</Text>
    </>}
  </ScrollView><Modal visible={!!challenge} onRequestClose={() => { if (!busy) setChallenge(null); }}><SafeAreaView style={styles.camera}><Text style={styles.cameraTitle}>Live attendance selfie</Text><Text style={styles.cameraNote}>Face the camera. A fresh GPS fix is captured with your photo.</Text>{challenge && <CameraView ref={camera} style={{ flex: 1 }} facing="front" onCameraReady={() => setReady(true)} onMountError={event => { setChallenge(null); Alert.alert('Camera unavailable', event.message); }} />}<View style={{ padding: 20, gap: 12 }}><Button disabled={busy || !ready} title={busy ? 'Saving check-in…' : 'Capture & check in'} onPress={() => void act(capture)} /><Button disabled={busy} secondary title="Cancel" onPress={() => setChallenge(null)} /></View></SafeAreaView></Modal></SafeAreaView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F5F3' }, content: { padding: 22, gap: 15, paddingBottom: 44 }, header: { paddingHorizontal: 22, paddingVertical: 18, flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#DCE4DF' }, brand: { fontWeight: '800', letterSpacing: 2, color: '#102B39' }, link: { color: '#087F73', fontWeight: '700' },
  hero: { backgroundColor: '#102B39', padding: 24, borderRadius: 22, gap: 14 }, eyebrow: { color: '#81D9BC', letterSpacing: 2, fontSize: 12, fontWeight: '700' }, heroTitle: { color: 'white', fontWeight: '700', fontSize: 38 }, heroText: { color: '#D6E6E0', lineHeight: 22 }, title: { fontSize: 28, fontWeight: '700', color: '#102B39' }, section: { fontSize: 18, fontWeight: '700', color: '#102B39', marginBottom: 8 },
  card: { backgroundColor: 'white', borderWidth: 1, borderColor: '#E1E8E3', borderRadius: 20, padding: 20, gap: 12 }, field: { gap: 6, paddingVertical: 5 }, label: { color: '#70857D', fontSize: 12, fontWeight: '600' }, value: { color: '#668B7D', fontSize: 16, fontWeight: '600' }, row: { flexDirection: 'row', justifyContent: 'space-between' }, note: { color: '#65756E', fontSize: 13, lineHeight: 21 }, warning: { backgroundColor: '#FFF0CC', borderRadius: 14, padding: 18, gap: 14 },
  button: { backgroundColor: '#087F73', padding: 17, alignItems: 'center', borderRadius: 12, minHeight: 52 }, secondary: { backgroundColor: '#E6EEEA' }, buttonText: { color: 'white', fontWeight: '700', fontSize: 15 }, input: { borderWidth: 1, borderColor: '#CBD8D0', borderRadius: 12, backgroundColor: 'white', padding: 16, fontSize: 16 }, camera: { flex: 1, backgroundColor: '#102B39' }, cameraTitle: { color: 'white', fontSize: 24, fontWeight: '700', padding: 20 }, cameraNote: { color: '#D6E6E0', paddingHorizontal: 20, paddingBottom: 20 }
});

