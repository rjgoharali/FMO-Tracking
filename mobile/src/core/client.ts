import { ApiFailure, type PhotoJob, type Transport, type User } from './types.ts';
import type { Repository } from './repository.ts';
export type Credentials = { user: User; accessToken: string; refreshToken: string; expiresAt: number; refreshing: boolean; needsLogin?: 'uncertain' | 'revoked' };
export interface Vault { read(): Promise<Credentials | null>; save(value: Credentials): Promise<void>; clear(): Promise<void> }
type Options = { baseUrl: string; vault: Vault; repo: Repository; uuid(): string; fetch?: typeof fetch; photoBody(job: PhotoJob): FormData };
export class ApiClient implements Transport {
  options: Options; refreshFlight: Promise<Credentials> | null = null;
  constructor(options: Options) { this.options = options; }
  private async call<T>(path: string, method: string, body: unknown, token?: string, multipart = false): Promise<T> {
    const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), multipart ? 30000 : 20000);
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}${path}`, { method, signal: abort.signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(multipart || body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: multipart ? body as FormData : JSON.stringify(body) }) });
      let data: unknown;
      try { data = await response.json(); } catch { throw new ApiFailure(response.status >= 400 ? response.status : 502, 'INVALID_RESPONSE', 'Server returned an unreadable response. Your records are retained.'); }
      if (!response.ok) {
        const error = data as { code?: string; error?: string };
        throw new ApiFailure(response.status, error.code ?? 'REQUEST_FAILED', error.error ?? 'Request failed. Please try again.');
      }
      await this.options.repo.setValue('serverSeen', new Date().toISOString());
      return data as T;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(0, 'NETWORK_UNAVAILABLE', 'Unable to reach the server. Your saved records will synchronize when the connection returns.');
    } finally { clearTimeout(timeout); }
  }
  async login(employeeCode: string, password: string) {
    const result = await this.call<{ user: User; accessToken: string; refreshToken: string; expiresIn: number }>('/api/auth/login', 'POST', { employeeCode, password, client: 'mobile' });
    if (result.user.role !== 'FMO' || !result.user.fmoId) {
      await this.call('/api/auth/logout', 'POST', undefined, result.accessToken).catch(() => undefined);
      throw new ApiFailure(403, 'FMO_ONLY', 'Use an FMO account here. Administrators use the laptop dashboard.');
    }
    const pending = await this.options.repo.unfinished();
    if (pending && pending.ownerId !== result.user.id) {
      await this.call('/api/auth/logout', 'POST', undefined, result.accessToken).catch(() => undefined);
      throw new ApiFailure(403, 'PENDING_OTHER_ACCOUNT', 'A duty on this phone still needs synchronization. Sign in with its original FMO account.');
    }
    const previousOwner = await this.options.repo.value('owner');
    if (previousOwner && previousOwner !== result.user.id && (await this.options.repo.counts(previousOwner)).pending > 0) {
      await this.call('/api/auth/logout', 'POST', undefined, result.accessToken).catch(() => undefined);
      throw new ApiFailure(403, 'PENDING_OTHER_ACCOUNT', 'Synchronize the previous FMO’s saved locations before switching accounts.');
    }
    await this.options.vault.save({ user: result.user, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: Date.now() + result.expiresIn * 1000, refreshing: false });
    await this.options.repo.setValue('owner', result.user.id);
    await this.options.repo.setValue('profile', JSON.stringify(result.user));
    return result.user;
  }
  private async refresh(previous: Credentials) {
    if (this.refreshFlight) return this.refreshFlight;
    this.refreshFlight = (async () => {
      const holder = this.options.uuid();
      if (!await this.options.repo.lease('refresh', holder, Date.now(), 60000)) throw new ApiFailure(503, 'REFRESH_BUSY', 'Session renewal is in progress. Please retry shortly.');
      try {
        const latest = await this.options.vault.read();
        if (!latest || latest.user.id !== previous.user.id) throw new ApiFailure(401, 'LOGIN_REQUIRED', 'Please sign in again. Your duty and saved locations are retained.');
        if (latest.refreshing || !latest.refreshToken) throw new ApiFailure(latest.needsLogin === 'revoked' ? 401 : 0, 'LOGIN_REQUIRED', 'Please sign in again to synchronize. Saved records are retained.');
        if (latest.refreshToken !== previous.refreshToken) return latest;
        // A crash/uncertain response during rotation must never replay a used token.
        await this.options.vault.save({ ...latest, refreshing: true });
        const result = await this.call<{ user: User; accessToken: string; refreshToken: string; expiresIn: number }>('/api/auth/refresh', 'POST', { refreshToken: latest.refreshToken });
        const credentials: Credentials = { ...result, expiresAt: Date.now() + result.expiresIn * 1000, refreshing: false };
        await this.options.vault.save(credentials); return credentials;
      } catch (error) {
        const latest = await this.options.vault.read();
        const revoked = error instanceof ApiFailure && [401, 403].includes(error.status);
        if (latest?.refreshing) await this.options.vault.save({ ...latest, accessToken: '', refreshToken: '', expiresAt: 0, refreshing: false, needsLogin: revoked ? 'revoked' : 'uncertain' });
        if (error instanceof ApiFailure && error.status === 503 && error.code === 'REFRESH_BUSY') throw error;
        throw new ApiFailure(revoked ? 401 : 0, 'LOGIN_REQUIRED', 'Session renewal could not be confirmed. Sign in again; your saved records are retained.');
      } finally { await this.options.repo.release('refresh', holder); }
    })();
    try { return await this.refreshFlight; } finally { this.refreshFlight = null; }
  }
  private async authorized<T>(path: string, method: string, body?: unknown, multipart = false) {
    let credentials = await this.options.vault.read();
    if (!credentials) throw new ApiFailure(401, 'LOGIN_REQUIRED', 'Please sign in again to synchronize this duty.');
    if (credentials.refreshing || !credentials.refreshToken) throw new ApiFailure(credentials.needsLogin === 'revoked' ? 401 : 0, 'LOGIN_REQUIRED', 'Please sign in again to synchronize this duty.');
    if (credentials.expiresAt < Date.now() + 30000) credentials = await this.refresh(credentials);
    try { return await this.call<T>(path, method, body, credentials.accessToken, multipart); }
    catch (error) {
      if (!(error instanceof ApiFailure) || error.status !== 401) throw error;
      credentials = await this.refresh(credentials);
      return this.call<T>(path, method, body, credentials.accessToken, multipart);
    }
  }
  json<T>(path: string, method = 'GET', body?: unknown) { return this.authorized<T>(path, method, body); }
  selfie<T>(job: PhotoJob) { return this.authorized<T>('/api/duty/check-in', 'POST', this.options.photoBody(job), true); }
  async logout() {
    const current = await this.options.vault.read();
    if (!current) return;
    if (await this.options.repo.unfinished() || (await this.options.repo.counts(current.user.id)).pending) throw new Error('End duty and synchronize pending records before logging out.');
    await this.json('/api/auth/logout', 'POST');
    await this.options.vault.clear();
    await this.options.repo.setValue('profile', '');
  }
}
