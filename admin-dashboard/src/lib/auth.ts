import type { User } from '../types';
export class ApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
type Session = { user: User; accessToken: string; expiresAt: number };
type Reply = { user: User; accessToken: string; expiresIn: number };
const marker = 'fmo.web.authentication-interrupted';
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? 'https://fmo-tracking-api.muhammadgohar32.workers.dev').replace(/\/$/, '');
let session: Session | null = null; let rotation: Promise<Session> | null = null;
const listeners = new Set<() => void>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fmo-session-control') : null;
function changed(value: Session | null) { session = value; for (const listener of listeners) listener(); }
channel?.addEventListener('message', () => changed(null));
export const subscribeAuth = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const authSnapshot = () => session;
async function lock<T>(work: () => Promise<T>) {
  if (!navigator.locks) throw new Error('Use a current Chrome or Edge browser over HTTPS (or localhost) for secure session coordination.');
  return navigator.locks.request('fmo-web-auth', work);
}
async function raw(path: string, options: RequestInit = {}, token?: string) {
  try {
    return await fetch(`${apiBase}${path}`, { ...options, credentials: 'omit', cache: 'no-store', signal: options.signal ?? AbortSignal.timeout(20000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  } catch { throw new ApiError(0, 'NETWORK', 'Unable to reach the server. Check your connection and try again.'); }
}
async function read<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => { throw new ApiError(502, 'BAD_RESPONSE', 'The server returned an unreadable response.'); });
  if (!response.ok) throw new ApiError(response.status, data.code ?? 'REQUEST_FAILED', data.error ?? 'Request failed.');
  return data as T;
}
function accept(reply: Reply) {
  if (!['ADMIN', 'SUPER_ADMIN'].includes(reply.user.role)) throw new ApiError(403, 'ADMIN_REQUIRED', 'Use an administrator account here. FMO accounts sign in on Android.');
  const value = { user: reply.user, accessToken: reply.accessToken, expiresAt: Date.now() + reply.expiresIn * 1000 }; changed(value); return value;
}
export async function login(employeeCode: string, password: string) {
  return lock(async () => {
    localStorage.setItem(marker, '1');
    const reply = await read<Reply>(await raw('/api/auth/login', { method: 'POST', body: JSON.stringify({ employeeCode, password, client: 'web' }) }));
    if (reply.user.role === 'FMO') { await raw('/api/auth/logout', { method: 'POST' }, reply.accessToken).catch(() => undefined); throw new ApiError(403, 'ADMIN_REQUIRED', 'Use an administrator account here. FMOs use the Android app.'); }
    localStorage.removeItem(marker); channel?.postMessage('session-changed'); return accept(reply);
  });
}
export async function refreshSession() {
  if (rotation) return rotation;
  rotation = lock(async () => {
    if (localStorage.getItem(marker)) { changed(null); throw new ApiError(401, 'LOGIN_REQUIRED', 'Sign in again. A previous session change could not be confirmed.'); }
    // Persist only a nonsecret uncertainty flag, never tokens or officer data.
    localStorage.setItem(marker, '1');
    try { const reply = await read<Reply>(await raw('/api/auth/refresh', { method: 'POST', body: '{}' })); const accepted = accept(reply); localStorage.removeItem(marker); return accepted; }
    catch (error) { changed(null); channel?.postMessage('signed-out'); throw error; }
  });
  try { return await rotation; } finally { rotation = null; }
}
export async function accessToken() { if (!session || session.expiresAt <= Date.now() + 60000) return (await refreshSession()).accessToken; return session.accessToken; }
export async function authorized(path: string, options: RequestInit = {}) {
  let token = await accessToken(); let response = await raw(path, options, token);
  if (response.status === 401) { token = (await refreshSession()).accessToken; response = await raw(path, options, token); }
  if (response.status === 401) { changed(null); localStorage.setItem(marker, '1'); channel?.postMessage('signed-out'); }
  return response;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return read<T>(await authorized(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
export async function selfie(id: string) {
  const response = await authorized('/api/attendance/' + encodeURIComponent(id) + '/selfie');
  if (!response.ok) await read(response);
  return response.blob();
}
export async function logout() {
  return lock(async () => {
    try { if (session) await read(await raw('/api/auth/logout', { method: 'POST' }, session.accessToken)); }
    finally { localStorage.setItem(marker, '1'); changed(null); channel?.postMessage('signed-out'); }
  });
}
