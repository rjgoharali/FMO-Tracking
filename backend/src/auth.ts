import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loginSchema, refreshSchema, changePasswordSchema } from '../../packages/contracts/src/api.js';
import { hashPassword, verifyPassword } from './password.js';
import { one, audit, type Database, type Db } from './db.js';
import { fail } from './errors.js';
import type { parseEnv } from './config.js';
import type { UserRow, Role, Principal } from './types.js';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const fingerprint = (value: unknown) => digest(JSON.stringify(value));
const userSelect = 'SELECT u.*,f.id AS fmo_id FROM users u LEFT JOIN fmos f ON f.user_id=u.id';
const dummyHash = `scrypt$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
export function publicUser(user: UserRow) {
  return { id: user.id, employeeCode: user.login_id, name: user.name, role: user.role, fmoId: user.fmo_id, isDemo: user.is_demo };
}
export class Auth {
  private secret: Uint8Array;
  constructor(public db: Database, public env: ReturnType<typeof parseEnv>) { this.secret = new TextEncoder().encode(env.JWT_SECRET); }
  async accessToken(user: UserRow, sessionId: string) {
    return new SignJWT({ sid: sessionId, ver: user.auth_version }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id).setIssuer('fmo-api').setAudience('fmo-clients').setIssuedAt().setExpirationTime(`${this.env.ACCESS_TOKEN_MINUTES}m`).sign(this.secret);
  }
  authenticate = async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) fail(401, 'UNAUTHENTICATED', 'Please log in');
    request.principal = await this.principalForToken(header.slice(7));
  };
  async principalForToken(token: string): Promise<Principal> {
    let subject: string; let sid: string; let version: number;
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'], issuer: 'fmo-api', audience: 'fmo-clients', typ: 'JWT' });
      if (!payload.sub || typeof payload.sid !== 'string' || typeof payload.ver !== 'number') throw new Error('Invalid claims');
      subject = payload.sub; sid = payload.sid; version = payload.ver;
      if (!/^[0-9a-f-]{36}$/i.test(subject) || !/^[0-9a-f-]{36}$/i.test(sid)) throw new Error('Invalid identifiers');
    } catch { fail(401, 'UNAUTHENTICATED', 'Session expired or invalid. Please log in'); }
    const user = await one<UserRow>(this.db, `${userSelect} JOIN auth_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.is_active AND u.auth_version=$3`, [subject, sid, version]);
    if (!user || (user.role === 'FMO' && !user.fmo_id)) fail(401, 'SESSION_REVOKED', 'Session is no longer valid. Please log in');
    return { userId: user.id, fmoId: user.fmo_id, role: user.role, sessionId: sid, authVersion: version };
  }
  roles = (...allowed: Role[]) => async (request: FastifyRequest) => {
    await this.authenticate(request);
    if (!allowed.includes(request.principal!.role)) fail(403, 'FORBIDDEN', 'Your role cannot perform this action');
  };
  async lockActor(tx: Db, actor: Principal) {
    const row = await one(tx, `SELECT u.id FROM users u JOIN auth_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND u.is_active AND u.auth_version=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s`,
      [actor.userId, actor.sessionId, actor.authVersion]);
    if (!row) fail(401, 'SESSION_REVOKED', 'Session is no longer valid');
  }
  private cookie(reply: FastifyReply, token: string) {
    reply.setCookie('fmo_refresh', token, { httpOnly: true, secure: this.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api/auth', maxAge: this.env.SESSION_DAYS * 86400 });
  }
  private requireOrigin(request: FastifyRequest) {
    if (!request.headers.origin || !this.env.origins.includes(request.headers.origin)) fail(403, 'ORIGIN_REJECTED', 'A trusted browser origin is required');
  }
  private send(reply: FastifyReply, tokens: { accessToken: string; refreshToken: string; user: ReturnType<typeof publicUser>; client: string }) {
    reply.header('Cache-Control', 'no-store');
    if (tokens.client === 'web') this.cookie(reply, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: this.env.ACCESS_TOKEN_MINUTES * 60, tokenType: 'Bearer', user: tokens.user,
      ...(tokens.client === 'mobile' ? { refreshToken: tokens.refreshToken } : {}) };
  }
  async register(app: FastifyInstance) {
    app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      const input = loginSchema.parse(request.body);
      if (input.client === 'web') this.requireOrigin(request);
      const counter = await one<{ attempts: number }>(this.db, `INSERT INTO login_rate_limits(key_hash) VALUES ($1)
        ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN login_rate_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE login_rate_limits.attempts+1 END,
        window_start=CASE WHEN login_rate_limits.window_start<now()-interval '15 minutes' THEN now() ELSE login_rate_limits.window_start END RETURNING attempts`, [digest(input.employeeCode)]);
      if (counter!.attempts > 20) fail(429, 'LOGIN_THROTTLED', 'Too many login attempts. Try again after 15 minutes');
      // FMOs may sign in with their registered full name or their unique FMO ID.
      // Admin accounts remain ID-only to avoid ambiguous administrator names.
      const user = await one<UserRow>(this.db, `${userSelect} WHERE u.login_id=$1 OR (u.role='FMO' AND lower(u.name)=lower($1))`, [input.employeeCode]);
      const correct = await verifyPassword(input.password, user?.password_hash ?? dummyHash);
      if (!correct || !user?.is_active || (user.role === 'FMO' && !user.fmo_id)) fail(401, 'INVALID_CREDENTIALS', 'Invalid FMO ID or password');
      const result = await this.db.transaction(async tx => {
        const locked = await one<UserRow>(tx, `${userSelect} WHERE u.id=$1 FOR UPDATE OF u`, [user.id]);
        if (!locked?.is_active || locked.password_hash !== user.password_hash) fail(401, 'INVALID_CREDENTIALS', 'Invalid FMO ID or password');
        const session = await one<{ id: string }>(tx, `INSERT INTO auth_sessions(user_id,client_type,expires_at) VALUES ($1,$2,now()+$3*interval '1 day') RETURNING id`, [user.id, input.client, this.env.SESSION_DAYS]);
        const refreshToken = randomBytes(48).toString('base64url');
        await tx.query('INSERT INTO refresh_tokens(user_id,session_id,token_hash,expires_at) SELECT user_id,id,$2,expires_at FROM auth_sessions WHERE id=$1', [session!.id, digest(refreshToken)]);
        await audit(tx, user.id, 'LOGIN', 'AUTH_SESSION', session!.id);
        return { accessToken: await this.accessToken(locked, session!.id), refreshToken, user: publicUser(locked), client: input.client };
      });
      return this.send(reply, result);
    });
    app.post('/api/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
      const input = refreshSchema.parse(request.body ?? {});
      const cookieToken = request.cookies.fmo_refresh;
      if (cookieToken) this.requireOrigin(request);
      if (cookieToken && input.refreshToken) fail(400, 'AMBIGUOUS_TOKEN', 'Use either cookie or mobile refresh token');
      const token = cookieToken ?? input.refreshToken;
      if (!token || !/^[A-Za-z0-9_-]{64}$/.test(token)) fail(401, 'INVALID_REFRESH', 'Please log in again');
      const result = await this.db.transaction(async tx => {
        // Lock in the same user -> session -> token order as logout/deactivation.
        const found = await one<{ user_id: string; session_id: string }>(tx, 'SELECT user_id,session_id FROM refresh_tokens WHERE token_hash=$1', [digest(token)]);
        if (!found?.session_id) return null;
        const user = await one<UserRow>(tx, `${userSelect} WHERE u.id=$1 FOR UPDATE OF u`, [found.user_id]);
        const session = await one<{ id: string; client_type: string; valid: boolean }>(tx, 'SELECT *,revoked_at IS NULL AND expires_at>clock_timestamp() AS valid FROM auth_sessions WHERE id=$1 FOR UPDATE', [found.session_id]);
        const refresh = await one<{ id: string; revoked_at: Date | null; valid: boolean }>(tx, 'SELECT *,expires_at>clock_timestamp() AS valid FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE', [digest(token)]);
        if (!user?.is_active || (user.role === 'FMO' && !user.fmo_id) || !session?.valid || !refresh?.valid) return null;
        if (session.client_type !== (cookieToken ? 'web' : 'mobile')) return null;
        if (refresh.revoked_at) {
          await tx.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [session.id]);
          await tx.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE session_id=$1', [session.id]);
          await audit(tx, user.id, 'REFRESH_REPLAY_REVOKED', 'AUTH_SESSION', session.id);
          return null; // Commit revocation before returning an HTTP error.
        }
        await tx.query('UPDATE refresh_tokens SET revoked_at=clock_timestamp() WHERE id=$1', [refresh.id]);
        const next = randomBytes(48).toString('base64url');
        await tx.query('INSERT INTO refresh_tokens(user_id,session_id,token_hash,expires_at) SELECT user_id,id,$2,expires_at FROM auth_sessions WHERE id=$1', [session.id, digest(next)]);
        return { accessToken: await this.accessToken(user, session.id), refreshToken: next, user: publicUser(user), client: session.client_type };
      });
      if (!result) { reply.clearCookie('fmo_refresh', { path: '/api/auth' }); fail(401, 'INVALID_REFRESH', 'Refresh token expired, revoked or reused. Please log in again'); }
      return this.send(reply, result);
    });
    app.get('/api/auth/me', { preHandler: this.authenticate }, async request => {
      const user = await one<UserRow>(this.db, `${userSelect} WHERE u.id=$1`, [request.principal!.userId]);
      return { user: publicUser(user!) };
    });
    app.post('/api/auth/logout', { preHandler: this.authenticate }, async (request, reply) => {
      const actor = request.principal!;
      await this.db.transaction(async tx => {
        await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.userId]);
        await tx.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [actor.sessionId]);
        await tx.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE session_id=$1', [actor.sessionId]);
        await audit(tx, actor.userId, 'LOGOUT', 'AUTH_SESSION', actor.sessionId);
      });
      reply.clearCookie('fmo_refresh', { path: '/api/auth' });
      return { success: true };
    });
    app.post('/api/auth/change-password', { preHandler: this.authenticate, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
      const input = changePasswordSchema.parse(request.body); const actor = request.principal!;
      const user = await one<UserRow>(this.db, `${userSelect} WHERE u.id=$1`, [actor.userId]);
      if (!user || !await verifyPassword(input.currentPassword, user.password_hash)) fail(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
      const hash = await hashPassword(input.newPassword);
      await this.db.transaction(async tx => {
        const locked = await one<UserRow>(tx, 'SELECT * FROM users WHERE id=$1 FOR UPDATE', [actor.userId]);
        if (locked?.password_hash !== user.password_hash) fail(409, 'PASSWORD_CHANGED', 'Password changed. Please log in again');
        await this.lockActor(tx, actor);
        await tx.query('UPDATE users SET password_hash=$2,auth_version=auth_version+1 WHERE id=$1', [actor.userId, hash]);
        await tx.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1', [actor.userId]);
        await tx.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1', [actor.userId]);
        await audit(tx, actor.userId, 'PASSWORD_CHANGED', 'USER', actor.userId);
      });
      reply.clearCookie('fmo_refresh', { path: '/api/auth' });
      return { success: true, requiresLogin: true };
    });
  }
}
