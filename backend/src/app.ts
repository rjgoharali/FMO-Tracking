import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { parseEnv } from './config.js';
import type { Database } from './db.js';
import { Auth } from './auth.js';
import { registerDuty } from './duty.js';
import { registerAdmin } from './admin.js';
import { registerRecords } from './records.js';
import { registerTracking } from './tracking.js';
import { registerRealtime } from './realtime.js';
import { registerReports } from './reports.js';
import { ApiError } from './errors.js';
import { noBiometricVerification, type PrivateStorage, type SelfieVerifier } from './storage.js';

export async function buildApp(env: ReturnType<typeof parseEnv>, databaseReady: () => Promise<boolean>, services?: { db: Database; storage: PrivateStorage; verifier?: SelfieVerifier }) {
  const app = Fastify({
    bodyLimit: 1024 * 1024, requestTimeout: 15000,
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'password', 'passwordHash'] },
  });
  await app.register(helmet);
  await app.register(cors, { origin: env.origins, credentials: true });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2, fieldSize: 16384 } });
  app.decorateRequest('principal', null);
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  app.get('/health/live', async () => ({ status: 'ok', service: 'fmo-api', phase: services ? 2 : 1 }));
  app.get('/health/ready', async (_request, reply) => {
    try { if (await databaseReady()) return { status: 'ready' }; } catch { /* Do not disclose database details. */ }
    return reply.code(503).send({ status: 'not_ready' });
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', code: 'VALIDATION_ERROR',
      issues: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })), requestId: request.id });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message, code: error.code, requestId: request.id });
    const databaseCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (databaseCode === '23505') return reply.code(409).send({ error: 'A record with this identifier already exists', code: 'CONFLICT', requestId: request.id });
    if (databaseCode === '23514' || databaseCode === '23503' || databaseCode === '22P02' || databaseCode === '22003') {
      return reply.code(422).send({ error: 'Request violates a data or duty rule', code: 'INVALID_STATE', requestId: request.id });
    }
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const code = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    // Never serialize arbitrary driver/storage errors, which may contain credentials or data.
    if (code === 500) request.log.error({ errorCode: typeof databaseCode === 'string' ? databaseCode : 'INTERNAL_ERROR' }, 'Request failed');
    reply.code(code).send({ error: code === 500 ? 'Internal server error. Please try again' : code === 429 ? 'Too many requests. Please try again later' : 'Request rejected',
      code: code === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED', requestId: request.id });
  });
  if (services) {
    const auth = new Auth(services.db, env);
    await auth.register(app);
    await registerDuty(app, services.db, auth, services.storage, services.verifier ?? noBiometricVerification);
    await registerAdmin(app, services.db, auth);
    await registerRecords(app, services.db, auth, services.storage);
    registerTracking(app, services.db, auth);
    registerReports(app, services.db, auth);
    registerRealtime(app, services.db, auth);
  }
  return app;
}
